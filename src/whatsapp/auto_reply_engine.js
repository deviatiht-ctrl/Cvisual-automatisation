import { isJidBroadcast, isJidStatusBroadcast, jidNormalizedUser } from '@whiskeysockets/baileys';
import { db } from '../database.js';

// Cache message IDs processed within the last few minutes to prevent any duplicate replies
const processedMessageIds = new Set();

// Anti-spam debounce per sender: senderPhone -> timestamp (ms)
const senderCooldowns = new Map();

// Multi-turn conversation memory per phone: senderPhone -> [{ role: 'user'|'model', text }]
const conversationMemory = new Map();

// Human takeover tracker: senderPhone -> timestamp (ms) when a human manager sent a message to this client
export const humanActiveChats = new Map();

// Track message IDs sent programmatically by this bot server to prevent self-takeover
export const botSentMessageIds = new Set();

// Ring buffer of recent auto-reply actions & decisions for live diagnostics
export const recentAutoReplyEvents = [];

export function logAutoReplyEvent(evt) {
  recentAutoReplyEvents.unshift({
    timestamp: new Date().toISOString(),
    ...evt
  });
  if (recentAutoReplyEvents.length > 80) recentAutoReplyEvents.pop();
}

export function clearHumanActiveChats() {
  humanActiveChats.clear();
}

// Candidate Gemini models with automatic failover (handles 429 quota exhaustion gracefully)
const GEMINI_MODELS = [
  'gemini-3.1-flash-lite-preview',
  'gemini-3.1-flash-lite',
  'gemini-3-flash-preview'
];

/**
 * Helper to determine if a message is from a WhatsApp Group, Community, Channel or Status.
 * Strictly isolates and protects 1-to-1 client chats.
 */
export function isGroupOrBroadcastMessage(msg) {
  if (!msg || !msg.key) return true;

  // 1. In WhatsApp Baileys, 'participant' is ONLY present in group / community messages
  if (msg.key.participant) return true;

  const rawJid = msg.key.remoteJid || '';
  if (!rawJid) return true;

  // 2. Reject all known group/broadcast JID patterns
  if (
    rawJid.endsWith('@g.us') ||
    rawJid.endsWith('@broadcast') ||
    rawJid.endsWith('@newsletter') ||
    rawJid.includes('@temp') ||
    isJidBroadcast(rawJid) ||
    isJidStatusBroadcast(rawJid)
  ) {
    return true;
  }

  // 3. Must be a direct individual client JID (@s.whatsapp.net or @lid)
  const isDirectClient = rawJid.endsWith('@s.whatsapp.net') || rawJid.endsWith('@lid');
  if (!isDirectClient) {
    return true;
  }

  return false;
}

// Helper to extract clean text from any Baileys message proto
export function extractMessageText(messageObj) {
  if (!messageObj) return '';
  if (typeof messageObj.conversation === 'string') return messageObj.conversation;
  if (messageObj.extendedTextMessage?.text) return messageObj.extendedTextMessage.text;
  if (messageObj.imageMessage?.caption) return messageObj.imageMessage.caption;
  if (messageObj.videoMessage?.caption) return messageObj.videoMessage.caption;
  if (messageObj.documentMessage?.caption) return messageObj.documentMessage.caption;
  if (messageObj.buttonsResponseMessage?.selectedDisplayText) {
    return messageObj.buttonsResponseMessage.selectedDisplayText;
  }
  if (messageObj.templateButtonReplyMessage?.selectedId) {
    return messageObj.templateButtonReplyMessage.selectedId;
  }
  return '';
}

/**
 * Closure & Courtesy acknowledgment patterns that should NOT trigger a reply.
 * (e.g. "ok merci", "mèsi", "d'accord", "bonne journée", "bye", emojis alone, etc.)
 */
const CLOSURE_PATTERNS = [
  /^(ok\s+)?(merci|m[eè]si|thanks)(\s+(beaucoup|anpil|anpil\s+wi))?[\s!.]*$/i,
  /^(ok|d['’]?accord|dak[oò]r?|c['’]?est\s+not[eé]|se\s+not[eé]|parfait|super|tr[eè]s\s+bien)[\s!.]*$/i,
  /^(bonne?\s+(journ[eé]e|soir[eé]e|apr[eè]s-midi)|[aà]\s+bient[oô]t|au\s+revoir|bye|tchao)[\s!.]*$/i,
  /^(pa\s+gen\s+pwobl[eè]m|de\s+rien|avec\s+plaisir|pas\s+de\s+quoi)[\s!.]*$/i,
  /^(d['’]?accord\s+merci|ok\s+m[eè]si|m[eè]si\s+oumenm|merci\s+[aà]\s+vous)[\s!.]*$/i,
  /^[\p{Emoji}\s!.]+$/u
];

export function isClosureOrNoReplyNeeded(text) {
  if (!text) return true;
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  return CLOSURE_PATTERNS.some(p => p.test(trimmed));
}

/**
 * Default Built-in Concierge Configuration for DALIGHT (Line #3)
 * Exported for backwards-compatibility with api/routes.js
 */
export const DALIGHT_CONCIERGE_CONFIG = {
  business_name: 'DALIGHT Head Spa & Bien-Etre',
  alert_phone: '50947477221',
  booking_url: 'https://dalightbeauty.com/pages/reservation-v2.html',
  booking_keywords: [
    'randevou', 'rdv', 'rezerve', 'rezève', 'rezèv', 'reserv', 'plas', 'disponib', 'pale ak moun', 'humain', 'vle vin', 'prendre rdv', 'reserver'
  ],
  buildBookingReply: () => {
    return (
      `Bonjour et bienvenue chez DALIGHT ! ✨\n\n` +
      `Pour planifier votre soin chez DALIGHT :\n\n` +
      `1️⃣ Rendez-vous sur notre plateforme officielle :\n` +
      `👉 https://dalightbeauty.com/pages/reservation-v2.html\n\n` +
      `2️⃣ Choisissez votre soin, praticienne, date et heure.\n` +
      `3️⃣ Validez votre créneau avec un acompte de 50% (MonCash, NatCash ou Virement au +509 4747-7221).\n\n` +
      `🔔 Notre responsable a également reçu votre demande et peut prendre le relais ici même d'un instant à l'autre !`
    );
  },
  buildGeneralReply: () => {
    return (
      `Bonjour ! Bienvenue chez DALIGHT Head Spa & Bien-Être.\n\n` +
      `Tous les jours de 07h00 à 17h00 (7j/7).\n` +
      `Site web : https://dalightbeauty.com\n` +
      `Adresse : Delmas 65, Rue Faustin Premier / Rue Durandisse #10.\n` +
      `Réservation : https://dalightbeauty.com/pages/reservation-v2.html\n\n` +
      `Comment puis-je vous aider aujourd'hui ?`
    );
  },
  buildAlertMessage: (senderPhone, text) => {
    return (
      `🚨 *ALERTE DALIGHT — INTENTION DE RDV DÉTECTÉE* 🌿\n\n` +
      `👤 *Client :* +${senderPhone}\n` +
      `💬 *Message :* « ${text} »\n` +
      `👉 *Répondre :* https://wa.me/${senderPhone}`
    );
  }
};

// ----------------------------------------------------
// DALIGHT LIVE SUPABASE SYNCHRONIZATION & GEMINI AI
// ----------------------------------------------------
const DALIGHT_SUPABASE_URL = 'https://rbwoiejztrkghfkpxquo.supabase.co';
const DALIGHT_SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJid29pZWp6dHJrZ2hma3B4cXVvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyMDI1OTcsImV4cCI6MjA5MTc3ODU5N30.4NnApWYerIEcS8IBixBdsVHSgTUDO4OTTi6fSxdxu_U';

let cachedServices = null;
let lastServicesFetch = 0;
let cachedGeminiKey = process.env.GEMINI_API_KEY || '';
let lastKeyFetch = 0;

async function getLiveDalightServices() {
  const now = Date.now();
  if (cachedServices && now - lastServicesFetch < 45000) {
    return cachedServices;
  }
  try {
    const res = await fetch(`${DALIGHT_SUPABASE_URL}/rest/v1/services?select=name,price_htg,price_usd,duration,category,description&is_active=eq.true&order=sort_order.asc`, {
      headers: {
        apikey: DALIGHT_SUPABASE_ANON,
        Authorization: `Bearer ${DALIGHT_SUPABASE_ANON}`
      }
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length) {
        cachedServices = data;
        lastServicesFetch = now;
        return cachedServices;
      }
    }
  } catch (err) {
    console.warn('[AutoReply DALIGHT] Live services fetch error:', err.message);
  }
  return cachedServices || [];
}

async function getDalightGeminiKey() {
  const now = Date.now();
  if (cachedGeminiKey && now - lastKeyFetch < 300000) {
    return cachedGeminiKey;
  }
  try {
    const res = await fetch(`${DALIGHT_SUPABASE_URL}/rest/v1/settings?key=eq.gemini_config`, {
      headers: {
        apikey: DALIGHT_SUPABASE_ANON,
        Authorization: `Bearer ${DALIGHT_SUPABASE_ANON}`
      }
    });
    if (res.ok) {
      const data = await res.json();
      const key = data?.[0]?.value?.api_key;
      if (key) {
        cachedGeminiKey = key;
        lastKeyFetch = now;
        return cachedGeminiKey;
      }
    }
  } catch (err) {
    console.warn('[AutoReply DALIGHT] Gemini key fetch error:', err.message);
  }
  return cachedGeminiKey || process.env.GEMINI_API_KEY || '';
}

/**
 * Generates an intelligent, natural human-like response for DALIGHT customers
 * Returns null if no reply is needed (silence for closure/irrelevant messages)
 */
async function generateDalightAiResponse(senderPhone, userText) {
  const trimmed = userText.trim();
  const lower = trimmed.toLowerCase();

  // 1. FILTER: Polite closures or acknowledgments -> DO NOT REPLY (remain silent)
  if (isClosureOrNoReplyNeeded(trimmed)) {
    console.log(`[AutoReply Concierge] Closure / acknowledgment detected from +${senderPhone} ("${trimmed}") -> SILENCE.`);
    return null;
  }

  // 2. Fast path for standalone greetings (under 10ms response time)
  const isOnlyGreeting = /^(bonjour|bonjou|salut|hello|hi|bonswa|bonsoir|hey|alo|allo)[\s!\.]*$/i.test(trimmed);
  if (isOnlyGreeting) {
    const greetingReply = lower.startsWith('bonjou') || lower.startsWith('bonswa')
      ? "Bonjou ! Byenvini nan DALIGHT Head Spa & Bien-Être. Kòman mwen ka ede w jodi a ?"
      : "Bonjour ! Bienvenue chez DALIGHT Head Spa & Bien-Être. Comment puis-je vous aider aujourd'hui ?";
    
    // Store in history
    const h = conversationMemory.get(senderPhone) || [];
    h.push({ role: 'user', text: trimmed });
    h.push({ role: 'assistant', text: greetingReply });
    if (h.length > 10) h.splice(0, h.length - 10);
    conversationMemory.set(senderPhone, h);

    return {
      text: greetingReply,
      isBookingIntent: false
    };
  }

  // Get live services from Supabase
  const services = await getLiveDalightServices();
  const servicesText = services.length
    ? services.map(s => `• ${s.name} : ${s.price_htg ? s.price_htg.toLocaleString() + ' HTG' : ''} (${s.price_usd ? '$' + s.price_usd + ' USD' : ''}) — Durée : ${s.duration || 'N/A'}`).join('\n')
    : "• Silver Head Spa : 5 000 HTG ($42 USD)\n• Golden Head Spa : 7 000 HTG ($59 USD)\n• Diamond Head Spa : 10 000 HTG ($84 USD)\n• Dreadlocks Head Spa : 6 000 HTG ($50 USD)\n• Massages : À partir de 10 000 HTG ($84 USD)";

  const systemInstruction = `Ou se Concierge Virtuel ofisyèl DALIGHT Head Spa & Bien-Être sou WhatsApp.
Ou se yon asistan distenge, koutwa e natirèl k ap pale ak kliyan yo (pa pale tankou yon wobo, pa voye mesaj prepare ki long). Pale kout, klè, ak anpil respè e chalè.

ENFÒMASYON OFISYÈL SOU DALIGHT :
- Non : DALIGHT Head Spa & Bien-Être
- Sit entènèt ofisyèl : https://dalightbeauty.com
- Lyen pou rezève an liy dirèkteman : https://dalightbeauty.com/pages/reservation-v2.html
- Telefòn ofisyèl : +509 4747-7221
- Adrès : Delmas 65, Rue Faustin Premier / Rue Durandisse #10, Port-au-Prince (avèk pakin prive sekirize).
- Orè : Tout jou nan semèn nan (Lendi rive Dimanch, 7j/7) soti 07h00 nan maten rive 17h00 (5h PM).
- Pwosesis pou pran randevou :
  1. Kliyan an chwazi swen li vle a.
  2. Kliyan an chwazi dat ak lè ki bon pou li a.
  3. Kliyan an voye non li ak nimewo li, oswa li ale dirèkteman sou sit la https://dalightbeauty.com/pages/reservation-v2.html.
  4. Pou bloke plas la, yon ti akonp de 50% nesesè (MonCash/NatCash sou +509 4747-7221).

SWEN AK PRI AKTYÈL AN DIRÈK :
${servicesText}
Opsyon videyo 4K souvni : +500 HTG (rezo sosyal) / +1 000 HTG (itilizasyon prive).

⚠️ RÈG ENPÒTAN SOU REZÈVASYON AK PEMAN (STRIKTEMAN ENTÈDI POU BOT LA KONFIME PEMAN) :
1. OU PA JANM GEN POUVWA KONFIME YON PEMAN OUBYEN YON REZÈVASYON OU MENM :
   - Ou se yon AI, ou PA gen aksè ak kont labank/MonCash/NatCash salon an. Ou pa ka wè si kòb la rantre.
   - Si yon kliyan di "mwen voye l", "mwen peye l", "mwen fè transfè a", oswa "men resi a" : PA JANM di "mwen resevwa l" oswa "randevou a konfime" !
   - Olye de sa, reponn : "Mèsi anpil ! Tanpri fè yon ti pasyante, responsab nou an ap verifye tranzaksyon an touswit pou l ka konfime randevou a pou ou." (oswa an Franse : "Merci beaucoup ! Veuillez patienter un court instant, notre responsable vérifie le paiement pour confirmer définitivement votre réservation.").
   - Mete TOUJOU tag [ALERT_RDV] nan fen repons lan !

2. OUSITO YON KLIYAN DI LI VLE PRAN YON SÈVIS OUBYEN LI VOYE ENFÒMASYON L (Non, Dat, Lè) :
   - Mande l fè yon ti pasyante pandan responsab la ap pran relè a pou finalize kreyno a avè l.
   - Mete TOUJOU tag [ALERT_RDV] pou responsab la resevwa alèt la.

3. SI KLIYAN AN RETOUNEN EKRI SOU REZÈVASYON AN OUBYEN PEMAN AN PANDAN RESPONSAB LA POKO PRAN RELÈ A :
   - Rasire l kout : di l responsab la gentan gen notifikasyon an e l ap pran swen sa touswit la.

4. SI KLIYAN AN POZE YON LÒT KESYON (Pa egzanp sou yon lòt swen, pri, adrès, sit web, orè, pakin) :
   - Reponn kesyon an dirèkteman, klè e kout, san w pa bliye mande l si l ta renmen planifye yon randevou pou sa tou.

5. LÈ YON MOUN MANDE ENFÒMASYON OUBYEN PRI YON SÈVIS :
   - Bay pri a ak detay yo touswit.
   - Toujou mande l koutwa : "Èske w ta renmen nou planifye yon randevou pou ou ?" / "Souhaitez-vous que l'on vous réserve un créneau ?"

6. RÈG SILANS TOTAL :
   - Si kliyan an annik di yon senp mo koutwazi pou fini konvèsasyon an ("ok merci", "mèsi", "d'accord", "bonne journée", "bye", "dakò", "👍") : reponn STRICTEMENT: [SILENCE].
   - Si mesaj la pa gen OKENN RAPÒ ak DALIGHT oswa salon/swen/bote (spam, blag, politik) : reponn STRICTEMENT: [SILENCE].`;

  // Multi-turn history
  const history = conversationMemory.get(senderPhone) || [];

  const geminiKey = await getDalightGeminiKey();
  if (geminiKey) {
    const contents = [];
    // Add up to 6 previous turns
    history.slice(-6).forEach(h => {
      contents.push({
        role: h.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: h.text }]
      });
    });
    // Add current message
    contents.push({
      role: 'user',
      parts: [{ text: trimmed }]
    });

    // Try candidate models with automatic failover
    for (const modelName of GEMINI_MODELS) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${geminiKey}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents,
            systemInstruction: { parts: [{ text: systemInstruction }] },
            generationConfig: {
              maxOutputTokens: 2048,
              temperature: 0.5
            }
          })
        });

        if (res.ok) {
          const data = await res.json();
          let reply = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

          if (!reply || reply.includes('[SILENCE]') || reply.trim().length === 0) {
            console.log(`[AutoReply Concierge] (${modelName}) returned [SILENCE] for +${senderPhone} -> no reply.`);
            return null;
          }

          // Check if AI detected booking intent with tag
          const hasBookingAlertTag = reply.includes('[ALERT_RDV]');
          if (hasBookingAlertTag) {
            reply = reply.replace(/\[ALERT_RDV\]/g, '').trim();
          }

          // Record in conversation history
          history.push({ role: 'user', text: trimmed });
          history.push({ role: 'assistant', text: reply });
          if (history.length > 10) history.splice(0, history.length - 10);
          conversationMemory.set(senderPhone, history);

          return {
            text: reply,
            isBookingIntent: hasBookingAlertTag
          };
        } else {
          console.warn(`[AutoReply DALIGHT] Model ${modelName} returned HTTP ${res.status}, trying next model...`);
        }
      } catch (callErr) {
        console.warn(`[AutoReply DALIGHT] Call error on ${modelName}:`, callErr.message);
      }
    }
  }

  // Intelligent Local Fallback if AI is offline
  const isRelevant = /site|sit|web|head\s*spa|massage|masaj|soin|swen|cheveu|pri|tarif|prix|combien|konbyen|heure|l[eè]|horaire|or[eè]|adresse|adr[eè]s|ouvert|f[eè]m|rdv|randevou|reserve|rez[eè]v|rendez/i.test(lower);
  if (!isRelevant) {
    console.log(`[AutoReply Concierge] Fallback: Message from +${senderPhone} deemed not relevant -> SILENCE.`);
    return null;
  }

  let fallback = '';
  let isBooking = false;

  if (lower.includes('site') || lower.includes('sit') || lower.includes('web')) {
    fallback = `Wi, ou ka vizite sit entènèt ofisyèl nou an isit la : https://dalightbeauty.com kote w ap jwenn tout detay sou sèvis nou yo ak galri nou an. Èske w ta renmen nou planifye yon randevou pou ou ?`;
  } else if (lower.includes('voye') || lower.includes('peye') || lower.includes('transfert') || lower.includes('moncash') || lower.includes('natcash') || lower.includes('acompte') || lower.includes('akomp')) {
    fallback = `Mèsi anpil ! Tanpri fè yon ti pasyante, responsab nou an ap verifye tranzaksyon an touswit pou l ka konfime randevou a pou ou.`;
    isBooking = true;
  } else if (lower.includes('procesus') || lower.includes('pwosesis') || lower.includes('koman poum') || lower.includes('comment reserver')) {
    fallback = `Pou pran randevou, se trè senp : chwazi swen ou vle a, dat ak lè ki bon pou ou a, epi voye non w ban nou (oswa ale sou https://dalightbeauty.com/pages/reservation-v2.html). Yon akonp 50% bloke plas la. Èske w ta renmen nou pran enfòmasyon w kounye a ?`;
  } else if (lower.includes('randevou') || lower.includes('rdv') || lower.includes('rezerve') || lower.includes('rezève') || lower.includes('reserver') || lower.includes('pran')) {
    fallback = `Avèk plezi ! Mwen note demann ou an. Tanpri fè yon ti pasyante, responsab nou an ap pran kontak avèk ou touswit la pou konfimasyon an.`;
    isBooking = true;
  } else if (lower.includes('pri') || lower.includes('prix') || lower.includes('combien') || lower.includes('konbyen') || lower.includes('head spa')) {
    fallback = `Nan DALIGHT, rityèl Head Spa Japonais nou yo kòmanse a 5 000 HTG ($42 USD) pou Silver (60 min), 7 000 HTG pou Golden, ak 10 000 HTG pou Diamond.\n\nÈske w ta renmen nou planifye yon randevou pou ou ?`;
  } else if (lower.includes('heure') || lower.includes('lè') || lower.includes('horaire') || lower.includes('orè') || lower.includes('ouvert')) {
    fallback = `DALIGHT louvri tout jou nan semèn nan (7j/7) soti 07h00 nan maten rive 17h00 (5h PM).\n\nÈske w ta renmen pran yon randevou ?`;
  } else if (lower.includes('adresse') || lower.includes('adrès') || lower.includes('kote') || lower.includes('local')) {
    fallback = `Nou sitiye nan Delmas 65, Rue Faustin Premier / Rue Durandisse #10, Port-au-Prince (avèk pakin prive sekirize).\n\nÈske w ta renmen nou rezève yon kreyno pou ou ?`;
  } else {
    fallback = `Bonjou ! Byenvini nan DALIGHT Head Spa & Bien-Être. Kòman mwen ka rann ou sèvis jodi a ?`;
  }

  return {
    text: fallback,
    isBookingIntent: isBooking
  };
}

/**
 * Dispatches an Auto-Reply to an incoming Baileys message if applicable.
 */
export async function handleIncomingMessageAutoReply({ accountInstance, sock, messages, type }) {
  if (!Array.isArray(messages) || messages.length === 0) return;

  const accountIndex = accountInstance.accountIndex;
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);

  // 1. Resolve Account & Tenant information
  let accountDb = null;
  let tenant = null;
  try {
    accountDb = await db.getAccountByIndex(accountIndex);
    if (accountDb?.tenant_id) {
      tenant = await db.getTenantById(accountDb.tenant_id);
    }
  } catch (err) {
    console.warn(`[AutoReply Engine] Error resolving account/tenant for Line ${accountIndex}:`, err.message);
  }

  // Determine if this account is DALIGHT (Line 3 or matching tenant/label)
  const isDalight =
    accountIndex === 3 ||
    accountDb?.tenant_id === 'c21aa659-f837-4c81-9e55-ccef534f9420' ||
    (accountDb?.label && accountDb.label.toLowerCase().includes('dalight')) ||
    (tenant?.name && tenant.name.toLowerCase().includes('dalight'));

  // Tenant auto-reply config
  let tenantMeta = null;
  if (tenant?.id) {
    try {
      tenantMeta = await db.getTenantMeta(tenant.id);
    } catch {}
  }

  const customAutoReply = tenantMeta?.auto_reply || null;
  const isAutoReplyEnabled = isDalight ? (customAutoReply?.enabled !== false) : Boolean(customAutoReply?.enabled);

  for (const msg of messages) {
    if (!msg || !msg.message) continue;

    const rawRemoteJid = msg.key?.remoteJid;
    if (!rawRemoteJid) continue;

    const textPreview = extractMessageText(msg.message);
    const msgTs = Number(msg.messageTimestamp?.low ?? msg.messageTimestamp ?? nowSec);
    const isRecentRealtime = Math.abs(nowSec - msgTs) <= 45;

    logAutoReplyEvent({
      action: 'INCOMING_FRAME',
      fromMe: Boolean(msg.key?.fromMe),
      remoteJid: rawRemoteJid,
      msgId: msg.key?.id,
      text: textPreview ? textPreview.slice(0, 50) : null
    });

    // 🌟 1. HUMAN TAKEOVER DETECTION (FromMe === true)
    // Ignore messages sent programmatically by the bot server!
    if (msg.key?.fromMe) {
      if (msg.key?.id && botSentMessageIds.has(msg.key.id)) {
        botSentMessageIds.delete(msg.key.id);
        continue;
      }
      if ((rawRemoteJid.endsWith('@s.whatsapp.net') || rawRemoteJid.endsWith('@lid')) && isRecentRealtime) {
        const clientUser = jidNormalizedUser(rawRemoteJid);
        const clientPhone = clientUser.split('@')[0].replace(/\D/g, '');
        if (clientPhone) {
          humanActiveChats.set(clientPhone, now);
          logAutoReplyEvent({ action: 'HUMAN_TAKEOVER_RECORDED', clientPhone });
          console.log(`[AutoReply Concierge] Human manager replied to +${clientPhone}. AI auto-reply paused for 15m.`);
        }
      }
      continue;
    }

    // 🌟 2. STRICT GROUP & BROADCAST ISOLATION
    // Never process or alert on group messages, newsletters, status broadcasts, or community announcements!
    if (isGroupOrBroadcastMessage(msg)) {
      continue;
    }

    const remoteJid = jidNormalizedUser(rawRemoteJid);
    const senderPhone = remoteJid.split('@')[0].replace(/\D/g, '');
    if (!senderPhone || senderPhone.length < 8) continue;

    // Never reply if the sender is strictly the account's own phone number
    const lineOwnPhone = (accountInstance.phoneNumber || accountDb?.phone_number || '').replace(/\D/g, '');
    if (lineOwnPhone && senderPhone === lineOwnPhone) {
      logAutoReplyEvent({ action: 'IGNORED_OWN_PHONE', senderPhone, lineOwnPhone });
      continue;
    }

    // 🌟 3. HUMAN TAKEOVER CHECK
    // If a human manager replied to this customer within the last 15 minutes, STAND DOWN!
    const lastHumanReplyAt = humanActiveChats.get(senderPhone) || 0;
    if (now - lastHumanReplyAt < 15 * 60 * 1000) {
      const minutesAgo = Math.round((now - lastHumanReplyAt) / 60000);
      logAutoReplyEvent({ action: 'IGNORED_HUMAN_ACTIVE', senderPhone, minutesAgo });
      console.log(`[AutoReply Concierge] Chat with +${senderPhone} is currently handled by human (${minutesAgo}m ago). AI stands down.`);
      continue;
    }

    // Check message age: ignore old replayed messages (> 180s)
    if (msgTs > 0 && nowSec - msgTs > 180) {
      logAutoReplyEvent({ action: 'IGNORED_OLD_TIMESTAMP', senderPhone, msgTs, nowSec, diffSec: nowSec - msgTs });
      continue;
    }

    // Message ID deduplication
    const msgId = msg.key?.id;
    if (!msgId || processedMessageIds.has(msgId)) continue;
    processedMessageIds.add(msgId);
    if (processedMessageIds.size > 2000) {
      const first = processedMessageIds.values().next().value;
      processedMessageIds.delete(first);
    }

    // Extract text
    const text = extractMessageText(msg.message);
    if (!text || text.trim().length === 0) continue;

    if (!isAutoReplyEnabled) {
      logAutoReplyEvent({ action: 'IGNORED_AUTOREPLY_DISABLED', senderPhone, text });
      continue;
    }

    // Rate-limiting / anti-burst debounce: 2.0 seconds to prevent packet bounce
    const lastSenderMsgAt = senderCooldowns.get(senderPhone) || 0;
    const minDebounceMs = isDalight ? 2000 : 5000;
    if (now - lastSenderMsgAt < minDebounceMs) {
      logAutoReplyEvent({ action: 'IGNORED_RAPID_BOUNCE', senderPhone, text });
      console.log(`[AutoReply Engine] Line ${accountIndex}: Rapid packet bounce throttled for +${senderPhone}`);
      continue;
    }

    let replyText = '';
    let alertMessage = null;
    let alertRecipient = null;

    if (isDalight) {
      // 🌟 INTELLIGENT DALIGHT CONCIERGE (LIVE SUPABASE + GEMINI FLASH WITH AUTO-FAILOVER)
      console.log(`[AutoReply Concierge] DALIGHT received: "${text.trim()}" from +${senderPhone}`);
      const aiResult = await generateDalightAiResponse(senderPhone, text);

      // If aiResult is null (closure message like 'ok merci', or irrelevant message), DO NOT REPLY!
      if (!aiResult || !aiResult.text) {
        logAutoReplyEvent({ action: 'IGNORED_SILENCE_NEEDED', senderPhone, text });
        console.log(`[AutoReply Concierge] No reply needed for message: "${text.trim()}". Staying silent.`);
        continue;
      }

      replyText = aiResult.text;

      // Only alert the DALIGHT manager if the customer is genuinely booking!
      if (aiResult.isBookingIntent) {
        alertRecipient = '50947477221@s.whatsapp.net';
        alertMessage = `🚨 *ALERTE DALIGHT — INTENTION DE RDV DÉTECTÉE* 🌿\n\n👤 *Client :* +${senderPhone}\n💬 *Message :* « ${text.trim()} »\n⏰ *Heure :* ${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}\n\n👉 *Prendre le relais :* https://wa.me/${senderPhone}`;
      }
    } else if (customAutoReply) {
      const bizName = customAutoReply.business_name || tenant?.name || 'Notre Entreprise';
      replyText = `Bonjour et bienvenue chez ${bizName} ! ✨\n\nNous avons bien reçu votre message et un conseiller vous répondra sous peu.\n\nComment pouvons-nous vous aider ?`;
    }

    if (!replyText) continue;

    // Send the Auto-Reply
    try {
      console.log(`[AutoReply Concierge] [Line ${accountIndex}] 🤖 Sending AI reply to +${senderPhone}...`);
      let sent;
      try {
        sent = await sock.sendMessage(remoteJid, { text: replyText }, { quoted: msg });
      } catch (quoteErr) {
        console.warn(`[AutoReply Concierge] Quoted reply failed, sending direct text:`, quoteErr.message);
        sent = await sock.sendMessage(remoteJid, { text: replyText });
      }

      senderCooldowns.set(senderPhone, now);
      logAutoReplyEvent({
        action: 'REPLIED',
        senderPhone,
        text,
        replyPreview: replyText.slice(0, 100),
        isBooking: Boolean(alertRecipient)
      });

      // Record sent reply in account's in-memory messages store
      if (sent?.key?.id) {
        botSentMessageIds.add(sent.key.id);
        if (botSentMessageIds.size > 5000) {
          const first = botSentMessageIds.values().next().value;
          botSentMessageIds.delete(first);
        }
        accountInstance._recordWaMessage({
          key: {
            remoteJid,
            fromMe: true,
            id: sent.key.id
          },
          messageTimestamp: Math.floor(now / 1000),
          message: { conversation: replyText }
        });
      }

      // If genuine booking intent, dispatch instant alert to manager (+509 4747-7221)
      if (alertRecipient && alertMessage) {
        sock.sendMessage(alertRecipient, { text: alertMessage }).catch(err => {
          console.warn(`[AutoReply Concierge] Manager alert delivery failed:`, err.message);
        });
      }
    } catch (sendErr) {
      logAutoReplyEvent({ action: 'SEND_ERROR', senderPhone, error: sendErr.message });
      console.error(`[AutoReply Concierge] Error sending reply to +${senderPhone} on Line ${accountIndex}:`, sendErr.message);
    }
  }
}
