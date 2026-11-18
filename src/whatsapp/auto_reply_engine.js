import { isJidBroadcast, isJidStatusBroadcast, jidNormalizedUser } from '@whiskeysockets/baileys';
import { db } from '../database.js';

// Cache message IDs processed within the last few minutes to prevent any duplicate replies
const processedMessageIds = new Set();

// Anti-spam cooldown per sender: senderPhone -> timestamp (ms)
const senderCooldowns = new Map();

// Multi-turn conversation memory per phone: senderPhone -> [{ role: 'user'|'model', text }]
const conversationMemory = new Map();

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
 * Generates an intelligent, natural response for DALIGHT customers
 */
async function generateDalightAiResponse(senderPhone, userText) {
  const trimmed = userText.trim();
  const lower = trimmed.toLowerCase();

  // Fast path for simple greetings (under 10ms response time)
  const isOnlyGreeting = /^(bonjour|bonjou|salut|hello|hi|bonswa|bonsoir|hey|alo|allo)[\s!\.]*$/i.test(trimmed);
  if (isOnlyGreeting) {
    return {
      text: "Bonjour ! Bienvenue chez DALIGHT. Comment puis-je vous aider aujourd'hui ?",
      isBookingIntent: false
    };
  }

  // Get live services
  const services = await getLiveDalightServices();
  const servicesText = services.length
    ? services.map(s => `• ${s.name} : ${s.price_htg ? s.price_htg.toLocaleString() + ' HTG' : ''} (${s.price_usd ? '$' + s.price_usd + ' USD' : ''}) — Durée : ${s.duration || 'N/A'}`).join('\n')
    : "• Silver Head Spa : 5 000 HTG ($42 USD)\n• Golden Head Spa : 7 000 HTG ($59 USD)\n• Diamond Head Spa : 10 000 HTG ($84 USD)\n• Dreadlocks Head Spa : 6 000 HTG ($50 USD)\n• Massages : À partir de 10 000 HTG ($84 USD)";

  const systemInstruction = `Tu es le Concierge Virtuel officiel de DALIGHT Head Spa & Bien-Être sur WhatsApp.
Tu parles avec des clients réels.

RÈGLES D'OR DE COMMUNICATION :
1. PARLE NATURELLEMENT ET BRIÈVEMENT : 2 à 4 phrases maximum par message. Ne ponds JAMAIS de gros paragraphes ou de longs menus à moins que le client ne le demande expressément.
2. RÉPONDS EXACTEMENT À CE QUE LE CLIENT DEMANDE : S'il demande le prix du Head Spa, donne uniquement les prix du Head Spa clairement. S'il demande les horaires, donne les horaires.
3. ADRESSE ET CONTACT :
   - Adresse : Delmas 65, Rue Faustin Premier / Rue Durandisse #10, Port-au-Prince, Haïti (parking privé sécurisé).
   - Téléphone officiel : +509 4747-7221.
4. HORAIRES OFFICIELS STRICTS :
   - TOUS LES JOURS (Lundi au Dimanche, 7j/7) de 07h00 à 17h00.
5. PRISE DE RENDEZ-VOUS :
   - Pour réserver, invite le client à donner son Nom, Prénom, E-mail, le soin désiré ainsi que la date et l'heure souhaitées, ou à réserver directement en ligne : https://dalightbeauty.com/pages/reservation-v2.html
   - Acompte de 50% obligatoire (MonCash / NatCash / Virement Bancaire) pour confirmer.
6. LANGUE : Si le client écrit en Créole Haïtien (Kreyòl), comprends-le parfaitement et réponds en Français élégant et chaleureux (ou en Kreyòl s'il insiste).

SERVICES ET TARIFS ACTUELS EN DIRECT :
${servicesText}
Option vidéo 4K souvenir : +500 HTG (réseaux sociaux) / +1 000 HTG (usage privé).`;

  // Multi-turn history
  const history = conversationMemory.get(senderPhone) || [];

  // Detect booking intent
  const bookingKeywords = ['randevou', 'rdv', 'rezerve', 'rezève', 'rezèv', 'reserv', 'plas', 'disponib', 'pale ak moun', 'humain', 'vle vin', 'prendre rdv', 'reserver', 'rendez-vous'];
  const hasBookingKeywords = bookingKeywords.some(k => lower.includes(k));
  const hasClientDetails = /(@|gmail|yahoo|hotmail|[0-9]{4,})/i.test(trimmed);
  const isBookingIntent = hasBookingKeywords || hasClientDetails;

  const geminiKey = await getDalightGeminiKey();
  if (geminiKey) {
    try {
      const contents = [];
      // Add last 6 turns
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

      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${geminiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          systemInstruction: { parts: [{ text: systemInstruction }] },
          generationConfig: {
            thinkingConfig: { thinkingBudget: 0 },
            maxOutputTokens: 2048,
            temperature: 0.6
          }
        })
      });

      if (res.ok) {
        const data = await res.json();
        const reply = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (reply) {
          // Record history
          history.push({ role: 'user', text: trimmed });
          history.push({ role: 'assistant', text: reply });
          if (history.length > 12) history.splice(0, history.length - 12);
          conversationMemory.set(senderPhone, history);

          return {
            text: reply,
            isBookingIntent
          };
        }
      }
    } catch (err) {
      console.warn('[AutoReply DALIGHT] Gemini API error, falling back:', err.message);
    }
  }

  // Fallback if AI call failed
  let fallback = '';
  if (isBookingIntent) {
    fallback = `Avec plaisir ! Pour enregistrer votre rendez-vous chez DALIGHT, pouvez-vous me communiquer votre Nom complet, e-mail et la date souhaitée ?\n\nVous pouvez également réserver directement sur notre plateforme : https://dalightbeauty.com/pages/reservation-v2.html`;
  } else if (lower.includes('prix') || lower.includes('combien') || lower.includes('tarif') || lower.includes('head spa')) {
    fallback = `Chez DALIGHT, nos rituels Head Spa débutent à 5 000 HTG (Silver, 60 min). Nous proposons aussi les forfaits Golden à 7 000 HTG et Diamond à 10 000 HTG.\n\nQuel type de soin aimeriez-vous découvrir ?`;
  } else if (lower.includes('heure') || lower.includes('horaire') || lower.includes('ouvert') || lower.includes('ferm')) {
    fallback = `DALIGHT vous accueille tous les jours (du lundi au dimanche, 7j/7) de 07h00 à 17h00.\n\nSouhaitez-vous planifier un créneau ?`;
  } else if (lower.includes('adresse') || lower.includes('kote') || lower.includes('ou se trouve') || lower.includes('local')) {
    fallback = `Nous sommes situés à Delmas 65, Rue Faustin Premier / Rue Durandisse #10, Port-au-Prince (parking privé sécurisé).\n\nComment puis-je vous aider ?`;
  } else {
    fallback = `Bonjour ! Bienvenue chez DALIGHT Head Spa & Bien-Être. Comment puis-je vous être utile aujourd'hui ?`;
  }

  return {
    text: fallback,
    isBookingIntent
  };
}

/**
 * Dispatches an Auto-Reply to an incoming Baileys message if applicable.
 */
export async function handleIncomingMessageAutoReply({ accountInstance, sock, messages, type }) {
  if (type !== 'notify') return;
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
    // 1. Filter out messages sent from self, status broadcasts, and groups
    if (!msg.message || msg.key?.fromMe) continue;
    const rawRemoteJid = msg.key?.remoteJid;
    if (!rawRemoteJid) continue;
    if (
      rawRemoteJid.endsWith('@g.us') ||
      rawRemoteJid === 'status@broadcast' ||
      isJidBroadcast(rawRemoteJid) ||
      isJidStatusBroadcast(rawRemoteJid)
    ) {
      continue;
    }

    const remoteJid = jidNormalizedUser(rawRemoteJid);
    const senderPhone = remoteJid.split('@')[0].replace(/\D/g, '');

    // Never reply if the sender is strictly the same account number
    const lineOwnPhone = (accountInstance.phoneNumber || accountDb?.phone_number || '').replace(/\D/g, '');
    if (lineOwnPhone && senderPhone === lineOwnPhone) continue;

    // Check message age: ignore old replayed messages (> 180s)
    const msgTs = Number(msg.messageTimestamp?.low ?? msg.messageTimestamp ?? nowSec);
    if (msgTs > 0 && nowSec - msgTs > 180) {
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
      continue;
    }

    // Rate-limiting / anti-burst debounce: 2.5 seconds to prevent packet bounce
    const lastSenderMsgAt = senderCooldowns.get(senderPhone) || 0;
    const minDebounceMs = isDalight ? 2500 : 5000;
    if (now - lastSenderMsgAt < minDebounceMs) {
      console.log(`[AutoReply Engine] Line ${accountIndex}: Rapid packet bounce throttled for +${senderPhone}`);
      continue;
    }

    let replyText = '';
    let alertMessage = null;
    let alertRecipient = null;

    if (isDalight) {
      // 🌟 INTELLIGENT DALIGHT CONCIERGE (LIVE SUPABASE + GEMINI 3 FLASH)
      console.log(`[AutoReply Concierge] DALIGHT received: "${text.trim()}" from +${senderPhone}`);
      const aiResult = await generateDalightAiResponse(senderPhone, text);
      replyText = aiResult.text;

      // If client expressed intent to book, alert the DALIGHT manager
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
      const sent = await sock.sendMessage(remoteJid, { text: replyText }, { quoted: msg });

      senderCooldowns.set(senderPhone, now);

      // Record sent reply in account's in-memory messages store
      if (sent?.key?.id) {
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

      // If booking intent, dispatch instant alert to manager (+509 4747-7221)
      if (alertRecipient && alertMessage) {
        sock.sendMessage(alertRecipient, { text: alertMessage }).catch(err => {
          console.warn(`[AutoReply Concierge] Manager alert delivery failed:`, err.message);
        });
      }
    } catch (sendErr) {
      console.error(`[AutoReply Concierge] Error sending reply to +${senderPhone} on Line ${accountIndex}:`, sendErr.message);
    }
  }
}
