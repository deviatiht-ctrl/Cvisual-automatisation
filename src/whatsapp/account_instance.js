import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  fetchLatestWaWebVersion,
  isJidBroadcast,
  isJidStatusBroadcast,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';
import NodeCache from '@cacheable/node-cache';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import QRCode from 'qrcode';
import { db } from '../database.js';
import { config } from '../config.js';
import { applySpintaxAndHashShield } from '../shield.js';
import { sessionStore } from './session_store.js';

const silentPinoLogger = pino({ level: 'silent' });
const FALLBACK_WA_VERSION = [2, 3000, 1054146148];
let cachedWaVersion = FALLBACK_WA_VERSION;
let lastWaVersionFetchAt = 0;

async function resolveLatestWaVersion() {
  const now = Date.now();
  if (now - lastWaVersionFetchAt < 4 * 3600 * 1000 && Array.isArray(cachedWaVersion)) {
    return cachedWaVersion;
  }
  try {
    const webVer = await fetchLatestWaWebVersion({});
    if (Array.isArray(webVer?.version) && webVer.version.length === 3) {
      cachedWaVersion = webVer.version;
      lastWaVersionFetchAt = now;
      return cachedWaVersion;
    }
  } catch {}
  try {
    const bVer = await fetchLatestBaileysVersion();
    if (Array.isArray(bVer?.version) && bVer.version.length === 3) {
      cachedWaVersion = bVer.version;
      lastWaVersionFetchAt = now;
      return cachedWaVersion;
    }
  } catch {}
  return cachedWaVersion;
}

export function cleanupTmpChromeDirs() {
  // No-op kept for backward compatibility (native Baileys uses zero Chromium)
}

export function normalizePhoneDigits(raw, defaultCountryCode = '509') {
  if (!raw) return '';
  let digits = String(raw).replace(/\D/g, '');
  const cleanCode = String(defaultCountryCode || '509').replace(/\D/g, '');
  if (digits.length === 8 && cleanCode.length > 0) {
    digits = cleanCode + digits;
  }
  return digits;
}

function normalizePdfBase64(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let cleaned = raw.trim();
  const marker = 'base64,';
  const idx = cleaned.indexOf(marker);
  if (idx !== -1) cleaned = cleaned.slice(idx + marker.length);
  cleaned = cleaned.replace(/\s+/g, '');
  return cleaned.length > 0 ? cleaned : null;
}

function extractMessageText(messageObj) {
  if (!messageObj) return '';
  if (typeof messageObj.conversation === 'string') return messageObj.conversation;
  if (messageObj.extendedTextMessage?.text) return messageObj.extendedTextMessage.text;
  if (messageObj.imageMessage?.caption) return messageObj.imageMessage.caption || '📷 Imaj';
  if (messageObj.imageMessage) return '📷 Imaj';
  if (messageObj.videoMessage?.caption) return messageObj.videoMessage.caption || '🎥 Videyo';
  if (messageObj.videoMessage) return '🎥 Videyo';
  if (messageObj.documentMessage) {
    const fn = messageObj.documentMessage.fileName || 'Dokiman';
    return messageObj.documentMessage.caption
      ? `📄 ${fn}\n${messageObj.documentMessage.caption}`
      : `📄 ${fn}`;
  }
  if (messageObj.audioMessage) return '🎵 Odyo';
  if (messageObj.stickerMessage) return '🏷️ Sticker';
  if (messageObj.buttonsResponseMessage?.selectedDisplayText) {
    return messageObj.buttonsResponseMessage.selectedDisplayText;
  }
  return '';
}

function detectMessageMeta(messageObj) {
  if (!messageObj) return { type: 'chat', hasMedia: false };
  if (messageObj.documentMessage) return { type: 'document', hasMedia: true };
  if (messageObj.imageMessage) return { type: 'image', hasMedia: true };
  if (messageObj.videoMessage) return { type: 'video', hasMedia: true };
  if (messageObj.audioMessage) return { type: 'ptt', hasMedia: true };
  if (messageObj.stickerMessage) return { type: 'sticker', hasMedia: true };
  return { type: 'chat', hasMedia: false };
}

export class WhatsAppAccountInstance extends EventEmitter {
  constructor(accountIndex, label = `Liy ${accountIndex}`) {
    super();
    this.accountIndex = parseInt(accountIndex, 10);
    this.label = label;
    this.sock = null;
    this.client = null; // Alias kept for diagnostics
    this.status = 'DISCONNECTED';
    this.phoneNumber = null;
    this.pushName = null;
    this.qrCodeDataUrl = null;
    this.rawQrCode = null;
    this.lastError = null;
    this.isInitializing = false;
    this.isRecovering = false;
    this.isBusy = false;
    this.isDestroyed = false;
    this.restartAttempts = 0;
    this.maxRestartAttempts = 8;
    this.qrCycleCount = 0;
    this.maxQrCyclesWhenUnpaired = 4;
    this._initGeneration = 0;
    this._reconnectTimer = null;
    this._saveCreds = null;

    // Pacing & daily counters (synced with CVISUAL DB & SecurGYM bridge)
    this.sentToday = 0;
    this.sentRemindersToday = 0;
    this.sentTransactionalToday = 0;
    this.consecutiveRemindersCount = 0;
    this.lastSentAt = 0;
    this.lastReminderSentAt = 0;
    this.restrictedUntil = null;
    this.restrictionReason = null;

    this.backupTimer = null;
    this.sessionPath = path.join(config.authDataDir, `baileys-account-${this.accountIndex}`);

    // Lightweight Caches for Baileys 7 & "Agrandir WhatsApp" Interactive Chats
    this.msgRetryCounterCache = new NodeCache({ stdTTL: 1800, useClones: false });
    this.userDevicesCache = new NodeCache({ stdTTL: 300, useClones: false });
    this.chatsStore = new Map();
    this.contactsStore = new Map();
    this.messagesStore = new Map();
    this.rawProtoStore = new Map();
  }

  checkRestricted() {
    if (this.status === 'RESTRICTED') {
      if (this.restrictedUntil && new Date(this.restrictedUntil).getTime() > Date.now()) {
        return true;
      }
      this.status = 'DISCONNECTED';
      this.restrictedUntil = null;
      this.restrictionReason = null;
    }
    return false;
  }

  isReady() {
    return (
      this.status === 'READY' &&
      this.sock !== null &&
      Boolean(this.phoneNumber) &&
      !this.checkRestricted()
    );
  }

  _rememberContact(c) {
    if (!c?.id) return;
    const jid = jidNormalizedUser(c.id);
    const name = c.notify || c.name || c.verifiedName || null;
    if (name) {
      if (this.contactsStore.size > 600) {
        const firstKey = this.contactsStore.keys().next().value;
        this.contactsStore.delete(firstKey);
      }
      this.contactsStore.set(jid, name);
    }
  }

  _upsertChatSummary(chatId, patch = {}) {
    if (!chatId || isJidBroadcast(chatId) || isJidStatusBroadcast(chatId)) return;
    const jid = jidNormalizedUser(chatId);
    const existing = this.chatsStore.get(jid) || {
      id: jid,
      name: this.contactsStore.get(jid) || jid.split('@')[0],
      phone: jid.split('@')[0],
      isGroup: jid.endsWith('@g.us'),
      unreadCount: 0,
      timestamp: 0,
      lastMessage: null
    };
    const merged = {
      ...existing,
      ...patch,
      name: patch.name || this.contactsStore.get(jid) || existing.name || jid.split('@')[0]
    };
    this.chatsStore.set(jid, merged);
    if (this.chatsStore.size > 150) {
      const oldest = Array.from(this.chatsStore.entries())
        .sort((a, b) => (a[1].timestamp || 0) - (b[1].timestamp || 0))[0];
      if (oldest) this.chatsStore.delete(oldest[0]);
    }
  }

  _recordWaMessage(waMsg) {
    if (!waMsg?.key?.remoteJid) return;
    const rawJid = waMsg.key.remoteJid;
    if (isJidBroadcast(rawJid) || isJidStatusBroadcast(rawJid)) return;

    const jid = jidNormalizedUser(rawJid);
    const id = waMsg.key.id || String(Date.now());
    const fromMe = Boolean(waMsg.key.fromMe);
    const ts = Number(waMsg.messageTimestamp?.low ?? waMsg.messageTimestamp ?? Math.floor(Date.now() / 1000));
    const body = extractMessageText(waMsg.message);
    const meta = detectMessageMeta(waMsg.message);
    const pushName = waMsg.pushName || null;

    if (pushName && !fromMe) {
      this.contactsStore.set(jid, pushName);
    }

    if (waMsg.message && id) {
      if (this.rawProtoStore.size > 250) {
        const firstKey = this.rawProtoStore.keys().next().value;
        this.rawProtoStore.delete(firstKey);
      }
      this.rawProtoStore.set(`${jid}:${id}`, waMsg.message);
    }

    const msgEntry = {
      id,
      body,
      fromMe,
      timestamp: ts,
      type: meta.type,
      hasMedia: meta.hasMedia,
      author: waMsg.key.participant || jid,
      ack: Number(waMsg.status || (fromMe ? 2 : 3))
    };

    const list = this.messagesStore.get(jid) || [];
    const existingIdx = list.findIndex(m => m.id === id);
    if (existingIdx >= 0) {
      list[existingIdx] = { ...list[existingIdx], ...msgEntry };
    } else {
      list.push(msgEntry);
      list.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      if (list.length > 50) list.splice(0, list.length - 50);
    }
    this.messagesStore.set(jid, list);

    const prevChat = this.chatsStore.get(jid);
    if (!prevChat || ts >= (prevChat.timestamp || 0)) {
      this._upsertChatSummary(jid, {
        name: pushName && !fromMe ? pushName : undefined,
        timestamp: ts,
        lastMessage: {
          body: msgEntry.body,
          fromMe: msgEntry.fromMe,
          timestamp: ts,
          type: msgEntry.type,
          hasMedia: msgEntry.hasMedia
        }
      });
    }
  }

  async _getStoredProtoMessage(key) {
    if (!key?.remoteJid || !key?.id) return undefined;
    const jid = jidNormalizedUser(key.remoteJid);
    return this.rawProtoStore.get(`${jid}:${key.id}`);
  }

  async initialize({ userTriggered = false } = {}) {
    if (this.isDestroyed) return;
    if (this.checkRestricted()) {
      console.log(`[Account ${this.accountIndex}] Restricted until ${this.restrictedUntil}, skipping init.`);
      return;
    }
    if (this.isInitializing) return;
    if (userTriggered) {
      this.qrCycleCount = 0;
      this.restartAttempts = 0;
      this.lastError = null;
    }

    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    const gen = ++this._initGeneration;
    if (this.sock) {
      try {
        this.sock.ev.removeAllListeners();
      } catch {}
      try {
        this.sock.end(undefined);
      } catch {}
      this.sock = null;
      this.client = null;
    }
    this.isInitializing = true;
    this.lastError = null;
    await this.updateStatus('INITIALIZING', { qr_code_data_url: null });

    try {
      await sessionStore.restore(this.accountIndex, this.sessionPath);
      if (gen !== this._initGeneration || this.isDestroyed) return;

      fs.mkdirSync(this.sessionPath, { recursive: true });
      const { state, saveCreds } = await useMultiFileAuthState(this.sessionPath);
      this._saveCreds = saveCreds;
      const waVersion = await resolveLatestWaVersion();
      if (gen !== this._initGeneration || this.isDestroyed) return;

      console.log(
        `[Account ${this.accountIndex}] Démarrage WhatsApp Cloud Natif (Baileys v${waVersion.join('.')}, registered=${Boolean(state.creds?.registered)})...`
      );

      const sock = makeWASocket({
        version: waVersion,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, silentPinoLogger)
        },
        browser: Browsers.macOS('Chrome'),
        logger: silentPinoLogger,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        connectTimeoutMs: 25000,
        keepAliveIntervalMs: 25000,
        defaultQueryTimeoutMs: 60000,
        msgRetryCounterCache: this.msgRetryCounterCache,
        userDevicesCache: this.userDevicesCache,
        getMessage: async (key) => this._getStoredProtoMessage(key)
      });

      this.sock = sock;
      this.client = sock;

      sock.ev.on('creds.update', async () => {
        if (gen !== this._initGeneration || this.isDestroyed) return;
        try {
          await saveCreds();
          if (state.creds?.registered) {
            sessionStore.scheduleBackup(this.accountIndex, this.sessionPath, 8000);
          }
        } catch (err) {
          console.warn(`[Account ${this.accountIndex}] saveCreds error:`, err.message);
        }
      });

      sock.ev.on('contacts.upsert', (contacts) => {
        for (const c of Array.isArray(contacts) ? contacts : []) this._rememberContact(c);
      });

      sock.ev.on('contacts.update', (updates) => {
        for (const c of Array.isArray(updates) ? updates : []) this._rememberContact(c);
      });

      sock.ev.on('chats.upsert', (chats) => {
        for (const ch of Array.isArray(chats) ? chats : []) {
          this._upsertChatSummary(ch.id, {
            name: ch.name || undefined,
            unreadCount: Number(ch.unreadCount || 0),
            timestamp: Number(ch.conversationTimestamp || ch.t || 0)
          });
        }
      });

      sock.ev.on('chats.update', (updates) => {
        for (const u of Array.isArray(updates) ? updates : []) {
          if (!u?.id) continue;
          this._upsertChatSummary(u.id, {
            ...(u.unreadCount !== undefined ? { unreadCount: Number(u.unreadCount) } : {}),
            ...(u.conversationTimestamp ? { timestamp: Number(u.conversationTimestamp) } : {})
          });
        }
      });

      sock.ev.on('messaging-history.set', ({ chats, contacts, messages }) => {
        for (const c of Array.isArray(contacts) ? contacts : []) this._rememberContact(c);
        for (const ch of Array.isArray(chats) ? chats : []) {
          this._upsertChatSummary(ch.id, {
            name: ch.name || undefined,
            unreadCount: Number(ch.unreadCount || 0),
            timestamp: Number(ch.conversationTimestamp || 0)
          });
        }
        for (const m of Array.isArray(messages) ? messages : []) {
          this._recordWaMessage(m);
        }
      });

      sock.ev.on('messages.upsert', ({ messages }) => {
        for (const m of Array.isArray(messages) ? messages : []) {
          this._recordWaMessage(m);
        }
      });

      sock.ev.on('connection.update', async (update) => {
        if (gen !== this._initGeneration || this.isDestroyed) return;
        const { connection, lastDisconnect, qr, reachoutTimeLock } = update;

        if (reachoutTimeLock?.isActive) {
          const untilIso = reachoutTimeLock.timeEnforcementEnds
            ? new Date(reachoutTimeLock.timeEnforcementEnds).toISOString()
            : new Date(Date.now() + 24 * 3600 * 1000).toISOString();
          const hoursLeft = Math.max(1, Math.ceil((new Date(untilIso).getTime() - Date.now()) / 3600000));
          await this.markRestricted(hoursLeft, `Restriksyon WhatsApp (${reachoutTimeLock.enforcementType || 'reachoutTimeLock'})`);
          return;
        }

        if (qr) {
          try {
            const qrDataUrl = await QRCode.toDataURL(qr, {
              width: 300,
              margin: 2,
              color: { dark: '#0f172a', light: '#ffffff' }
            });
            this.rawQrCode = qr;
            this.qrCodeDataUrl = qrDataUrl;
            this.lastError = null;
            this.isInitializing = false;
            await this.updateStatus('SCAN_QR', { qr_code_data_url: qrDataUrl });
            console.log(`[Account ${this.accountIndex}] ⚡ Kòd QR jenere ak siksè! Prè pou eskane.`);
            this.emit('qr', { accountIndex: this.accountIndex, qr, qrDataUrl });
          } catch (err) {
            console.error(`[Account ${this.accountIndex}] Erreur génération QR:`, err.message);
          }
        }

        if (connection === 'open') {
          const meId = sock.user?.id || state.creds?.me?.id || '';
          this.phoneNumber = normalizePhoneDigits(meId.split(':')[0].split('@')[0], '');
          this.pushName = sock.user?.name || state.creds?.me?.name || null;
          this.rawQrCode = null;
          this.qrCodeDataUrl = null;
          this.lastError = null;
          this.isInitializing = false;
          this.restartAttempts = 0;
          this.qrCycleCount = 0;

          await this.updateStatus('READY', {
            phone_number: this.phoneNumber,
            qr_code_data_url: null
          });

          console.log(
            `[Account ${this.accountIndex}] ✅ Ligne WhatsApp PRÊTE (READY): ${this.pushName || 'SecurGYM'} (+${this.phoneNumber})`
          );

          this.startBackupSchedule();
          sessionStore.backup(this.accountIndex, this.sessionPath).catch(() => {});
          this.emit('ready', {
            accountIndex: this.accountIndex,
            phoneNumber: this.phoneNumber,
            pushName: this.pushName
          });
        }

        if (connection === 'close') {
          this.isInitializing = false;
          this.stopBackupSchedule();
          if (this.sock === sock) {
            this.sock = null;
            this.client = null;
          }

          const boomErr = lastDisconnect?.error;
          const statusCode = boomErr?.output?.statusCode ?? boomErr?.statusCode ?? 0;
          const errMsg = String(boomErr?.message || 'Koneksyon fèmen');
          const upperMsg = errMsg.toUpperCase();
          const wasRegistered = Boolean(state.creds?.registered || this.phoneNumber);

          console.warn(
            `[Account ${this.accountIndex}] Koneksyon fèmen (code=${statusCode}, registered=${wasRegistered}): ${errMsg}`
          );

          // 1. Standard Baileys post-QR pairing handoff (515 restartRequired)
          if (statusCode === DisconnectReason.restartRequired) {
            console.log(`[Account ${this.accountIndex}] 🔄 Re-koneksyon otomatik apre skàn QR (515)...`);
            this.rawQrCode = null;
            this.qrCodeDataUrl = null;
            try {
              if (this._saveCreds) await this._saveCreds();
            } catch {}
            await this.updateStatus('AUTHENTICATED', { qr_code_data_url: null });
            this.emit('authenticated', { accountIndex: this.accountIndex });
            this._reconnectTimer = setTimeout(() => {
              if (!this.isDestroyed && gen === this._initGeneration) {
                this.initialize().catch(() => {});
              }
            }, 800);
            return;
          }

          // 2. Account blocked / forbidden (403)
          if (
            statusCode === DisconnectReason.forbidden ||
            upperMsg.includes('RESTRICT') ||
            upperMsg.includes('BAN')
          ) {
            await this.markRestricted(24, `Restriksyon/Blokaj WhatsApp (${statusCode}: ${errMsg})`);
            return;
          }

          // 3. Forced logout / unlinked from phone (401)
          if (statusCode === DisconnectReason.loggedOut) {
            this.emit('disconnected', { accountIndex: this.accountIndex, reason: 'LOGOUT' });
            console.warn(`[Account ${this.accountIndex}] LOGOUT (401) — netwayaj sesyon pou pèmèt yon nouvo QR.`);
            await this.resetSession({ awaitInit: wasRegistered });
            return;
          }

          // 4. Connection replaced by another client (440)
          if (statusCode === DisconnectReason.connectionReplaced) {
            this.phoneNumber = null;
            this.pushName = null;
            this.rawQrCode = null;
            this.qrCodeDataUrl = null;
            this.lastError = 'Sesyon ranplase pa yon lòt koneksyon (440). Klike "Rekonekte" pou reprann li.';
            await this.updateStatus('DISCONNECTED', { qr_code_data_url: null });
            this.emit('disconnected', { accountIndex: this.accountIndex, reason: 'REPLACED' });
            return;
          }

          // 5. Unpaired QR timeout (e.g. nobody scanned after several QR refreshes)
          if (!wasRegistered && (statusCode === DisconnectReason.timedOut || errMsg.includes('QR refs attempts ended'))) {
            this.qrCycleCount += 1;
            this.rawQrCode = null;
            this.qrCodeDataUrl = null;

            if (this.qrCycleCount < this.maxQrCyclesWhenUnpaired) {
              const delayMs = 6000;
              console.log(
                `[Account ${this.accountIndex}] 🔄 Rafrechi kòd QR (${this.qrCycleCount}/${this.maxQrCyclesWhenUnpaired}) nan 6s...`
              );
              this._reconnectTimer = setTimeout(() => {
                if (!this.isDestroyed && gen === this._initGeneration) {
                  this.initialize().catch(() => {});
                }
              }, delayMs);
              return;
            }

            this.lastError = 'Tan skàn kòd QR la ekspire. Klike sou "Rekonekte / Eskane QR" pou afiche yon nouvo kòd QR.';
            await this.updateStatus('DISCONNECTED', { qr_code_data_url: null });
            return;
          }

          // 6. Registered line network drop — auto-recover seamlessly
          this.phoneNumber = null;
          this.pushName = null;
          this.rawQrCode = null;
          this.qrCodeDataUrl = null;
          this.lastError = `Rekoneksyon otomatik (${statusCode || 'net'}): ${errMsg}`;
          await this.updateStatus('DISCONNECTED', { qr_code_data_url: null });
          this.emit('disconnected', { accountIndex: this.accountIndex, reason: errMsg });

          if (wasRegistered || this.restartAttempts < this.maxRestartAttempts) {
            this.restartAttempts = Math.min(this.maxRestartAttempts, this.restartAttempts + 1);
            const backoffMs = Math.min(30000, 2000 * Math.pow(1.5, this.restartAttempts));
            console.warn(
              `[Account ${this.accountIndex}] 🔄 Re-koneksyon otomatik nan ${Math.round(backoffMs / 1000)}s (tantativ ${this.restartAttempts})...`
            );
            this._reconnectTimer = setTimeout(() => {
              if (!this.isDestroyed && gen === this._initGeneration) {
                this.initialize().catch(() => {});
              }
            }, backoffMs);
          }
        }
      });

      this.isInitializing = false;
    } catch (error) {
      this.isInitializing = false;
      this.lastError = error?.message || String(error);
      console.error(`[Account ${this.accountIndex}] Erreur d'initialisation:`, this.lastError);
      await this.updateStatus('ERROR', { error_message: this.lastError });

      if (this.restartAttempts < this.maxRestartAttempts && !this.isDestroyed) {
        this.restartAttempts += 1;
        const backoffMs = Math.min(30000, 3000 * this.restartAttempts);
        this._reconnectTimer = setTimeout(() => {
          if (!this.isDestroyed && gen === this._initGeneration) {
            this.initialize().catch(() => {});
          }
        }, backoffMs);
      }
    }
  }

  startBackupSchedule() {
    this.stopBackupSchedule();
    const interval = config.sessionBackup?.intervalMs || 300000;
    this.backupTimer = setInterval(() => {
      if (this.isReady()) {
        sessionStore.backup(this.accountIndex, this.sessionPath).catch(() => {});
      }
    }, interval);
  }

  stopBackupSchedule() {
    if (this.backupTimer) {
      clearInterval(this.backupTimer);
      this.backupTimer = null;
    }
  }

  async ensureInjected() {
    if (!this.isReady()) {
      throw new Error(`Liy WhatsApp ${this.accountIndex} pa konekte pou kounye a.`);
    }
    return true;
  }

  async updateStatus(status, extra = {}) {
    this.status = status;
    try {
      await db.updateAccountStatus(this.accountIndex, status, extra);
    } catch (e) {
      console.error(`[Account ${this.accountIndex}] DB status update failed:`, e.message);
    }
  }

  async markRestricted(hours = 24, reason = 'Restriction temporaire WhatsApp') {
    this.status = 'RESTRICTED';
    this.restrictedUntil = new Date(Date.now() + hours * 3600 * 1000).toISOString();
    this.restrictionReason = reason;
    this.lastError = reason;
    this.qrCodeDataUrl = null;
    this.rawQrCode = null;
    this.stopBackupSchedule();
    console.warn(`[Account ${this.accountIndex}] 🔴 Ligne restreinte pour ${hours}h: ${reason}`);
    await this.updateStatus('RESTRICTED', {
      qr_code_data_url: null,
      restricted_until: this.restrictedUntil
    });
    await this.destroyBrowserOnly();
  }

  async unrestrict() {
    this.restrictedUntil = null;
    this.restrictionReason = null;
    this.lastError = null;
    await this.updateStatus('DISCONNECTED', { restricted_until: null });
    await this.restart({ awaitInit: false });
  }

  async destroyBrowserOnly() {
    this._initGeneration += 1;
    this.stopBackupSchedule();
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    try {
      if (this.sock) {
        try {
          this.sock.ev.removeAllListeners();
        } catch {}
        try {
          this.sock.end(undefined);
        } catch {}
        this.sock = null;
        this.client = null;
      }
      this._saveCreds = null;
    } catch {}
    this.isInitializing = false;
    this.isBusy = false;
  }

  async waitUntilFree(maxWaitMs = 15000) {
    const start = Date.now();
    while (this.isBusy) {
      if (Date.now() - start > maxWaitMs) {
        throw new Error(`Liy ${this.accountIndex} okipe ap voye yon lòt mesaj. Re-eseye nan kèk segonn.`);
      }
      await new Promise(r => setTimeout(r, 300));
    }
  }

  async sendMessage({ to, text, pdfBase64 = null, pdfFileName = null, kind = 'receipt' }) {
    if (!this.isReady()) {
      throw new Error(`Liy SIM ${this.accountIndex} pa prè (Estati: ${this.status})`);
    }

    const cleanNumber = normalizePhoneDigits(to, config.securgym?.defaultCountryCode || '509');
    if (!cleanNumber || cleanNumber.length < 8) {
      throw new Error('Nimewo destinataire la pa valid (omwen 8 chif).');
    }

    await this.waitUntilFree(15000);
    this.isBusy = true;

    try {
      const sock = this.sock;
      if (!sock) throw new Error(`Liy ${this.accountIndex} fèk dekonekte.`);

      // Verify whether number exists on WhatsApp so we never spam unregistered phones
      let targetJid = `${cleanNumber}@s.whatsapp.net`;
      try {
        const lookup = await sock.onWhatsApp(cleanNumber);
        if (Array.isArray(lookup) && lookup.length > 0) {
          if (lookup[0].exists === false) {
            throw new Error(`Nimewo +${cleanNumber} pa anrejistre sou WhatsApp.`);
          }
          if (lookup[0].jid) {
            targetJid = lookup[0].jid;
          }
        }
      } catch (checkErr) {
        if (String(checkErr?.message || '').includes('pa anrejistre sou WhatsApp')) {
          throw checkErr;
        }
        // USync lookup transient failure — continue with normalized PN JID
      }

      const isFastLane = ['receipt', 'welcome', 'otp', 'test', 'manual_direct'].includes(kind);
      const isReminder = !isFastLane;
      const shouldApplyShield = kind !== 'test' && kind !== 'manual_direct';
      const shieldResult = shouldApplyShield
        ? applySpintaxAndHashShield(text, { forceEngagement: isReminder, applyDoNotReply: isReminder })
        : {
            rawText: text,
            processedText: String(text || '').trim(),
            originalHash: null,
            shieldedHash: null,
            injectedCount: 0,
            typingSimulationMs: isFastLane ? 1100 : 2400
          };
      const finalMessageText = shieldResult.processedText;

      // Human typing presence simulation
      try {
        await sock.presenceSubscribe(targetJid).catch(() => {});
        await sock.sendPresenceUpdate('composing', targetJid);
        await new Promise(resolve => setTimeout(resolve, shieldResult.typingSimulationMs));
        await sock.sendPresenceUpdate('paused', targetJid);
      } catch {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      const cleanPdfB64 = normalizePdfBase64(pdfBase64);
      let pdfName = String(pdfFileName || 'Recu.pdf').trim();
      if (cleanPdfB64 && !pdfName.toLowerCase().endsWith('.pdf')) {
        pdfName += '.pdf';
      }

      let sentResult = null;
      try {
        if (cleanPdfB64) {
          const pdfBuffer = Buffer.from(cleanPdfB64, 'base64');
          sentResult = await sock.sendMessage(targetJid, {
            document: pdfBuffer,
            mimetype: 'application/pdf',
            fileName: pdfName,
            caption: finalMessageText
          });
        } else {
          sentResult = await sock.sendMessage(targetJid, { text: finalMessageText });
        }
      } catch (sendErr) {
        const errMsg = sendErr?.message ? sendErr.message : String(sendErr);
        const statusCode = sendErr?.output?.statusCode ?? sendErr?.statusCode ?? 0;

        if (
          statusCode === 401 ||
          statusCode === 403 ||
          errMsg.includes('rate-overlimit') ||
          errMsg.toLowerCase().includes('restricted')
        ) {
          await this.markRestricted(24, errMsg);
          throw new Error(`Ligne restreinte par WhatsApp: ${errMsg}`);
        }

        if (cleanPdfB64) {
          console.warn(`[Account ${this.accountIndex}] PDF failed (${errMsg}), falling back to text delivery...`);
          sentResult = await sock.sendMessage(targetJid, { text: finalMessageText });
        } else {
          throw sendErr;
        }
      }

      const now = Date.now();
      this.lastSentAt = now;
      this.sentToday += 1;
      if (isReminder) {
        this.sentRemindersToday += 1;
        this.lastReminderSentAt = now;
        this.consecutiveRemindersCount += 1;
      } else {
        this.sentTransactionalToday += 1;
      }

      await db.incrementAccountSent(this.accountIndex, isReminder);

      return {
        success: true,
        whatsappMessageId: sentResult?.key?.id || null,
        shield: {
          originalHash: shieldResult.originalHash,
          shieldedHash: shieldResult.shieldedHash,
          injectedCount: shieldResult.injectedCount,
          typingMs: shieldResult.typingSimulationMs
        }
      };
    } finally {
      this.isBusy = false;
    }
  }

  _normalizeChatId(rawChatId) {
    const s = String(rawChatId || '').trim();
    if (!s) return null;
    if (s.endsWith('@c.us')) {
      return s.slice(0, -5) + '@s.whatsapp.net';
    }
    if (s.includes('@')) return jidNormalizedUser(s);
    const digits = normalizePhoneDigits(s, config.securgym?.defaultCountryCode || '509');
    if (!digits || digits.length < 8) return null;
    return `${digits}@s.whatsapp.net`;
  }

  async listChats(limit = 35) {
    if (!this.isReady()) {
      throw new Error(`La ligne ${this.accountIndex} n'est pas connectée (Statut: ${this.status}).`);
    }
    const maxCount = Math.max(1, Math.min(Number(limit) || 35, 80));
    return Array.from(this.chatsStore.values())
      .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))
      .slice(0, maxCount);
  }

  async getChatMessages(rawChatId, limit = 50) {
    if (!this.isReady()) {
      throw new Error(`La ligne ${this.accountIndex} n'est pas connectée (Statut: ${this.status}).`);
    }
    const cid = this._normalizeChatId(rawChatId);
    if (!cid) throw new Error('Chat ID ou numéro invalide.');
    const maxCount = Math.max(1, Math.min(Number(limit) || 50, 100));
    const list = this.messagesStore.get(cid) || [];
    return list.slice(-maxCount);
  }

  async sendDirectChatMessage(rawChatId, message) {
    if (!this.isReady()) {
      throw new Error(`La ligne ${this.accountIndex} n'est pas connectée (Statut: ${this.status}).`);
    }
    const cid = this._normalizeChatId(rawChatId);
    if (!cid) throw new Error('Numéro destinataire invalide.');
    const cleanText = String(message || '').trim();
    if (!cleanText) throw new Error('Le message est vide.');

    await this.waitUntilFree(15000);
    this.isBusy = true;
    try {
      const sock = this.sock;
      if (!sock) throw new Error(`Liy ${this.accountIndex} pa prè.`);
      await sock.sendPresenceUpdate('composing', cid).catch(() => {});
      await new Promise(r => setTimeout(r, 900));
      await sock.sendPresenceUpdate('paused', cid).catch(() => {});

      const sent = await sock.sendMessage(cid, { text: cleanText });
      this.lastSentAt = Date.now();
      return {
        id: sent?.key?.id || String(Date.now()),
        body: cleanText,
        fromMe: true,
        timestamp: Math.floor(Date.now() / 1000),
        type: 'chat',
        hasMedia: false,
        ack: 1
      };
    } finally {
      this.isBusy = false;
    }
  }

  async restart({ awaitInit = true } = {}) {
    console.log(`[Account ${this.accountIndex}] Redémarrage de la connexion (session conservée)...`);
    this.isDestroyed = false;
    this.restrictedUntil = null;
    this.restrictionReason = null;
    this.lastError = null;
    this.qrCycleCount = 0;
    this.restartAttempts = 0;
    await this.destroyBrowserOnly();

    if (awaitInit) {
      await this.initialize({ userTriggered: true });
    } else {
      this.initialize({ userTriggered: true }).catch(err => {
        console.error(`[Account ${this.accountIndex}] Erreur restart:`, err.message);
      });
    }
  }

  async resetSession({ awaitInit = true } = {}) {
    console.log(`[Account ${this.accountIndex}] Réinitialisation complète de la session...`);
    this.isDestroyed = false;
    this.stopBackupSchedule();

    try {
      if (this.sock && this.status === 'READY') {
        await Promise.race([
          this.sock.logout().catch(() => {}),
          new Promise(r => setTimeout(r, 2500))
        ]);
      }
    } catch {}

    await this.destroyBrowserOnly();
    await sessionStore.remove(this.accountIndex).catch(() => {});

    try {
      if (fs.existsSync(this.sessionPath)) {
        fs.rmSync(this.sessionPath, { recursive: true, force: true });
      }
    } catch (err) {
      console.warn(`[Account ${this.accountIndex}] Avertissement suppression dossier session:`, err.message);
    }

    this.rawQrCode = null;
    this.qrCodeDataUrl = null;
    this.phoneNumber = null;
    this.pushName = null;
    this.lastError = null;
    this.restrictedUntil = null;
    this.restrictionReason = null;
    this.qrCycleCount = 0;
    this.restartAttempts = 0;

    await this.updateStatus('DISCONNECTED', {
      phone_number: null,
      qr_code_data_url: null,
      restricted_until: null
    });

    if (awaitInit) {
      await this.initialize({ userTriggered: true });
    } else {
      this.initialize({ userTriggered: true }).catch(err => {
        console.error(`[Account ${this.accountIndex}] Erreur resetSession:`, err.message);
      });
    }
  }
}
