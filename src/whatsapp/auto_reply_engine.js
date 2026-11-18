import { isJidBroadcast, isJidStatusBroadcast, jidNormalizedUser } from '@whiskeysockets/baileys';
import { db } from '../database.js';

// Cache message IDs processed within the last few minutes to prevent any duplicate replies
const processedMessageIds = new Set();

// Anti-spam cooldown per sender: senderPhone -> { lastGeneralAt, lastBookingAt }
const senderCooldowns = new Map();

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
 * Default Built-in Concierge Configuration for DALIGHT (Line #3)
 */
export const DALIGHT_CONCIERGE_CONFIG = {
  business_name: 'DALIGHT Head Spa & Bien-Etre',
  alert_phone: '50947477221',
  booking_url: 'https://dalightbeauty.com/pages/reservation-v2.html',
  booking_keywords: [
    'randevou',
    'rdv',
    'rezerve',
    'rezève',
    'rezèv',
    'reserv',
    'plas',
    'disponib',
    'pale ak moun',
    'humain',
    'vle vin'
  ],
  buildBookingReply: () => {
    return (
      `Bonjour et bienvenue chez DALIGHT ! ✨\n\n` +
      `Pour planifier votre soin chez DALIGHT :\n\n` +
      `1️⃣ Rendez-vous sur notre plateforme officielle :\n` +
      `👉 https://dalightbeauty.com/pages/reservation-v2.html\n\n` +
      `2️⃣ Choisissez votre soin, praticienne, date et heure.\n` +
      `3️⃣ Validez votre créneau avec un acompte de 50% (MonCash, NatCash ou Virement).\n\n` +
      `🔔 Notre responsable a également reçu votre demande et peut prendre le relais ici même d'un instant à l'autre !`
    );
  },
  buildGeneralReply: () => {
    return (
      `Bonjour et bienvenue chez DALIGHT ! ✨\n\n` +
      `C'est un réel plaisir de vous renseigner.\n\n` +
      `📍 Adresse : Delmas 65, Rue Faustin Premier / Rue Durandisse #10 (Parking privé sécurisé).\n` +
      `🕐 Horaires : Mar–Sam 08h–20h | Dim–Lun 08h–18h\n` +
      `🌿 Rituels : Signature 8 500 HTG (60 min), Sérénité Royale 12 000 HTG (90 min), Renaissance 6 500 HTG (45 min).\n` +
      `🎥 Option Vidéo 4K : +500 HTG (Public) / +1 000 HTG (Privé)\n\n` +
      `📅 Réservation en ligne : https://dalightbeauty.com/pages/reservation-v2.html\n\n` +
      `Comment pouvons-nous vous choyer aujourd'hui ?`
    );
  },
  buildAlertMessage: (senderPhone, text) => {
    return (
      `🚨 *ALERTE DALIGHT — DEMANDE DE RDV EN DIRECT !*\n\n` +
      `👤 Client : +${senderPhone}\n` +
      `💬 Message : « ${text} »\n` +
      `👉 Répondre : https://wa.me/${senderPhone}`
    );
  }
};

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

  // Tenant auto-reply config (from tenant metadata if exists)
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

    // Never reply to the line's own phone number or alert destination
    const lineOwnPhone = (accountInstance.phoneNumber || accountDb?.phone_number || '').replace(/\D/g, '');
    if (lineOwnPhone && senderPhone === lineOwnPhone) continue;
    if (isDalight && senderPhone === '50947477221') continue;

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

    // If auto-reply is not enabled for this line/tenant, skip replying
    if (!isAutoReplyEnabled) {
      continue;
    }

    // Detect booking intent
    const lower = text.toLowerCase();
    const keywords =
      customAutoReply?.booking_keywords ||
      DALIGHT_CONCIERGE_CONFIG.booking_keywords;
    const isBookingIntent = keywords.some(k => lower.includes(k.toLowerCase()));

    // Rate-limiting / Anti-spam cooldown per sender
    const cooldown = senderCooldowns.get(senderPhone) || { lastGeneralAt: 0, lastBookingAt: 0 };
    const generalCooldownMs = (customAutoReply?.general_cooldown_seconds || 180) * 1000; // 3 min
    const bookingCooldownMs = (customAutoReply?.booking_cooldown_seconds || 60) * 1000;   // 1 min

    if (isBookingIntent) {
      if (now - cooldown.lastBookingAt < bookingCooldownMs) {
        console.log(`[AutoReply Concierge] Line ${accountIndex}: Booking intent throttled for +${senderPhone}`);
        continue;
      }
    } else {
      if (now - cooldown.lastGeneralAt < generalCooldownMs) {
        console.log(`[AutoReply Concierge] Line ${accountIndex}: General reply throttled for +${senderPhone}`);
        continue;
      }
    }

    // Build the Concierge reply
    let replyText = '';
    let alertMessage = null;
    let alertRecipient = null;

    if (isDalight) {
      if (isBookingIntent) {
        replyText = customAutoReply?.booking_reply || DALIGHT_CONCIERGE_CONFIG.buildBookingReply();
        alertRecipient = (customAutoReply?.alert_phone || DALIGHT_CONCIERGE_CONFIG.alert_phone) + '@s.whatsapp.net';
        alertMessage = DALIGHT_CONCIERGE_CONFIG.buildAlertMessage(senderPhone, text.trim());
      } else {
        replyText = customAutoReply?.general_reply || DALIGHT_CONCIERGE_CONFIG.buildGeneralReply();
      }
    } else if (customAutoReply) {
      const bizName = customAutoReply.business_name || tenant?.name || 'Notre Entreprise';
      if (isBookingIntent && customAutoReply.booking_reply) {
        replyText = customAutoReply.booking_reply;
        if (customAutoReply.alert_phone) {
          alertRecipient = customAutoReply.alert_phone.replace(/\D/g, '') + '@s.whatsapp.net';
          alertMessage = `🚨 *ALERTE ${bizName.toUpperCase()} — NOUVELLE DEMANDE !*\n\n👤 Client : +${senderPhone}\n💬 Message : « ${text.trim()} »\n👉 Répondre : https://wa.me/${senderPhone}`;
        }
      } else {
        replyText =
          customAutoReply.general_reply ||
          `Bonjour et bienvenue chez ${bizName} ! ✨\n\nNous avons bien reçu votre message et un conseiller vous répondra sous peu.\n\nComment pouvons-nous vous aider ?`;
      }
    }

    if (!replyText) continue;

    // Send the Auto-Reply with quoted context
    try {
      console.log(`[AutoReply Concierge] [Account ${accountIndex}] 🤖 Sending Concierge reply to +${senderPhone} (Intent: ${isBookingIntent ? 'BOOKING' : 'GENERAL'})...`);
      const sent = await sock.sendMessage(remoteJid, { text: replyText }, { quoted: msg });

      // Update cooldown state
      if (isBookingIntent) {
        cooldown.lastBookingAt = now;
      } else {
        cooldown.lastGeneralAt = now;
      }
      senderCooldowns.set(senderPhone, cooldown);

      // Record sent reply in account's in-memory messages store for live view
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

      // If booking intent, dispatch instant alert to manager (Note to self / Manager WhatsApp)
      if (isBookingIntent && alertRecipient && alertMessage) {
        sock
          .sendMessage(alertRecipient, { text: alertMessage })
          .then(() => {
            console.log(`[AutoReply Concierge] [Account ${accountIndex}] 🚨 Alert delivered to manager (${alertRecipient})`);
          })
          .catch(err => {
            console.warn(`[AutoReply Concierge] Alert delivery failed to ${alertRecipient}:`, err.message);
          });
      }
    } catch (sendErr) {
      console.error(`[AutoReply Concierge] Error sending reply to +${senderPhone} on Line ${accountIndex}:`, sendErr.message);
    }
  }
}
