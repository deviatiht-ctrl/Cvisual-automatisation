import pkg from 'whatsapp-web.js';
const { Client, LocalAuth, MessageMedia } = pkg;
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { EventEmitter } from 'events';
import QRCode from 'qrcode';
import { db } from '../database.js';
import { config } from '../config.js';
import { applySpintaxAndHashShield } from '../shield.js';
import { sessionStore } from './session_store.js';

const require = createRequire(import.meta.url);
const { LoadUtils } = require('whatsapp-web.js/src/util/Injected/Utils.js');
const { ExposeAuthStore } = require('whatsapp-web.js/src/util/Injected/AuthStore/AuthStore.js');

const MODERN_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const STABLE_REMOTE_WA_URL =
  'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1053557623-alpha.html';
let cachedRemoteVersionUrl = STABLE_REMOTE_WA_URL;
let lastWaVersionFetchAt = 0;

async function refreshRemoteWaVersionIfNeeded() {
  const now = Date.now();
  if (now - lastWaVersionFetchAt < 6 * 3600 * 1000) return cachedRemoteVersionUrl;
  lastWaVersionFetchAt = now;
  try {
    const res = await fetch('https://api.github.com/repos/wppconnect-team/wa-version/contents/html', {
      headers: { 'User-Agent': 'CVISUAL-WA-Gateway' },
      signal: AbortSignal.timeout(3000)
    });
    if (res.ok) {
      const files = await res.json();
      if (Array.isArray(files) && files.length > 0) {
        const htmlFiles = files
          .map(f => f.name)
          .filter(n => typeof n === 'string' && n.endsWith('.html') && n.startsWith('2.'))
          .sort();
        const latest = htmlFiles[htmlFiles.length - 1];
        if (latest) {
          cachedRemoteVersionUrl = `https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/${latest}`;
        }
      }
    }
  } catch {
    // Keep stable fallback URL
  }
  return cachedRemoteVersionUrl;
}

function cleanChromiumLocks(sessionDir) {
  if (!sessionDir || !fs.existsSync(sessionDir)) return;
  const lockNames = new Set([
    'SingletonLock',
    'SingletonCookie',
    'SingletonSocket',
    'DevToolsActivePort',
    'lockfile'
  ]);

  const candidates = [sessionDir, path.join(sessionDir, 'Default')];
  for (const dir of candidates) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && lockNames.has(entry.name)) {
          try {
            fs.unlinkSync(path.join(dir, entry.name));
          } catch {}
        }
      }
    } catch {}
  }
}

export function cleanupTmpChromeDirs() {
  if (process.platform === 'win32') return;
  try {
    const tmpDir = os.tmpdir();
    for (const entry of fs.readdirSync(tmpDir, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        (entry.name.startsWith('puppeteer_dev_chrome_profile') ||
          entry.name.startsWith('.org.chromium.Chromium'))
      ) {
        try {
          fs.rmSync(path.join(tmpDir, entry.name), { recursive: true, force: true });
        } catch {}
      }
    }
  } catch {}
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

function isCrashErrorMessage(errStr = '') {
  return (
    errStr.includes('detached Frame') ||
    errStr.includes('Attempted to use') ||
    errStr.includes('Execution context') ||
    errStr.includes('Target closed') ||
    errStr.includes('Session closed') ||
    errStr.includes('Protocol error') ||
    errStr.includes('Déconnecté') ||
    errStr.includes('crashed')
  );
}

export class WhatsAppAccountInstance extends EventEmitter {
  constructor(accountIndex, label = `SIM ${accountIndex}`) {
    super();
    this.accountIndex = parseInt(accountIndex, 10);
    this.label = label;
    this.client = null;
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
    this.maxRestartAttempts = 5;

    // Pacing & daily counters (synced with both CVISUAL DB and SecurGYM bridge)
    this.sentToday = 0;
    this.sentRemindersToday = 0;
    this.sentTransactionalToday = 0;
    this.consecutiveRemindersCount = 0;
    this.lastSentAt = 0;
    this.lastReminderSentAt = 0;
    this.restrictedUntil = null;
    this.restrictionReason = null;

    this.backupTimer = null;
    this.sessionPath = path.join(config.authDataDir, `session-account-${this.accountIndex}`);
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
      this.client !== null &&
      Boolean(this.phoneNumber) &&
      this.client.pupPage !== null &&
      this.client.pupPage !== undefined &&
      !this.client.pupPage.isClosed?.() &&
      !this.checkRestricted()
    );
  }

  async initialize() {
    if (this.isDestroyed) return;
    if (this.checkRestricted()) {
      console.log(`[Account ${this.accountIndex}] Restricted until ${this.restrictedUntil}, skipping init.`);
      return;
    }
    if (this.isInitializing) return;
    this.isInitializing = true;
    this.lastError = null;
    await this.updateStatus('INITIALIZING', { qr_code_data_url: null });

    try {
      // Restore cloud session archive if ephemeral container storage was cleared
      await sessionStore.restore(this.accountIndex, this.sessionPath);
      cleanChromiumLocks(this.sessionPath);

      const waRemotePath = await refreshRemoteWaVersionIfNeeded();

      const puppeteerArgs = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-default-browser-check',
        '--no-zygote',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-blink-features=AutomationControlled',
        '--blink-settings=imagesEnabled=false',
        '--hide-scrollbars',
        '--mute-audio',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-component-update',
        '--disable-domain-reliability',
        '--disable-client-side-phishing-detection',
        '--disable-hang-monitor',
        '--disable-popup-blocking',
        '--disable-prompt-on-repost',
        '--no-pings',
        '--disk-cache-size=1',
        '--media-cache-size=1',
        '--renderer-process-limit=1',
        '--disable-breakpad',
        '--disable-features=Translate,OptimizationHints,MediaRouter,site-per-process,IsolateOrigins,AudioServiceOutOfProcess,BackForwardCache,PaintHolding',
        '--js-flags=--max-old-space-size=128'
      ];

      const puppeteerOptions = {
        headless: config.puppeteer.headless ? true : false,
        args: puppeteerArgs,
        userAgent: MODERN_USER_AGENT
      };

      if (config.puppeteer.executablePath) {
        puppeteerOptions.executablePath = config.puppeteer.executablePath;
      }

      console.log(
        `[Account ${this.accountIndex}] Lancement Chromium (${puppeteerOptions.executablePath || 'bundled'}, mem-cap)...`
      );

      this.client = new Client({
        authStrategy: new LocalAuth({
          clientId: `account-${this.accountIndex}`,
          dataPath: config.authDataDir
        }),
        webVersionCache: {
          type: 'remote',
          remotePath: waRemotePath
        },
        puppeteer: puppeteerOptions
      });

      this.setupEventHandlers();
      await this.client.initialize();
      this.isInitializing = false;
    } catch (error) {
      this.lastError = error.message || String(error);
      console.error(`[Account ${this.accountIndex}] Erreur d'initialisation:`, this.lastError);
      await this.updateStatus('ERROR', { error_message: this.lastError });
      this.isInitializing = false;
      this.handleCrashRecovery(error);
    }
  }

  setupEventHandlers() {
    if (!this.client) return;

    this.client.on('qr', async (qr) => {
      try {
        const qrDataUrl = await QRCode.toDataURL(qr, {
          width: 300,
          margin: 2,
          color: {
            dark: '#0f172a',
            light: '#ffffff'
          }
        });
        this.rawQrCode = qr;
        this.qrCodeDataUrl = qrDataUrl;
        this.lastError = null;
        this.isInitializing = false;
        await this.updateStatus('SCAN_QR', { qr_code_data_url: qrDataUrl });
        console.log(`[Account ${this.accountIndex}] QR Code généré instantanément! Prêt à scanner.`);
        this.emit('qr', { accountIndex: this.accountIndex, qr, qrDataUrl });
      } catch (err) {
        console.error(`[Account ${this.accountIndex}] Erreur génération QR:`, err.message);
      }
    });

    this.client.on('authenticated', () => {
      console.log(`[Account ${this.accountIndex}] Session WhatsApp authentifiée avec succès.`);
      this.rawQrCode = null;
      this.qrCodeDataUrl = null;
      this.lastError = null;
      this.restartAttempts = 0;
      this.updateStatus('AUTHENTICATED', { qr_code_data_url: null });
      this.emit('authenticated', { accountIndex: this.accountIndex });

      // Persist session backup after initial sync settles (avoids tar RAM spike during sync)
      setTimeout(() => {
        if (!this.isDestroyed && this.status !== 'DISCONNECTED') {
          sessionStore.backup(this.accountIndex, this.sessionPath).catch(() => {});
        }
      }, 35000);
    });

    this.client.on('auth_failure', async (msg) => {
      this.lastError = String(msg || 'Auth failure');
      console.error(`[Account ${this.accountIndex}] Échec d'authentification:`, this.lastError);
      this.isInitializing = false;
      await this.updateStatus('ERROR', { error_message: this.lastError });
      this.emit('auth_failure', { accountIndex: this.accountIndex, msg: this.lastError });
    });

    this.client.on('ready', async () => {
      const finalizeReady = async () => {
        const info = this.client?.info;
        this.phoneNumber = info?.wid?.user || null;
        this.pushName = info?.pushname || null;
        if (!this.phoneNumber) return false;

        this.lastError = null;
        this.isInitializing = false;
        this.restartAttempts = 0;

        try {
          await this.ensureInjected();
        } catch {}

        await this.updateStatus('READY', {
          phone_number: this.phoneNumber,
          qr_code_data_url: null
        });

        console.log(
          `[Account ${this.accountIndex}] ✅ Ligne WhatsApp PRÊTE (READY): ${this.pushName || 'SecurGYM'} (${this.phoneNumber})`
        );

        this.startBackupSchedule();
        setTimeout(() => {
          if (this.isReady()) {
            sessionStore.backup(this.accountIndex, this.sessionPath).catch(() => {});
          }
        }, 12000);
        this.emit('ready', { accountIndex: this.accountIndex, phoneNumber: this.phoneNumber, pushName: this.pushName });
        return true;
      };

      try {
        const done = await finalizeReady();
        if (!done) {
          console.warn(`[Account ${this.accountIndex}] 'ready' reçu sans info.wid — nouvelle vérification dans 2s...`);
          setTimeout(() => {
            finalizeReady().catch(() => {});
          }, 2000);
        }
      } catch (err) {
        console.error(`[Account ${this.accountIndex}] Erreur ready handler:`, err.message);
      }
    });

    this.client.on('disconnected', async (reason) => {
      const reasonStr = String(reason || '');
      const upper = reasonStr.toUpperCase();
      console.warn(`[Account ${this.accountIndex}] Ligne déconnectée: ${reasonStr}`);
      this.stopBackupSchedule();
      this.emit('disconnected', { accountIndex: this.accountIndex, reason: reasonStr });

      if (upper.includes('RESTRICT') || upper.includes('BAN')) {
        await this.markRestricted(24, `Déconnecté par WhatsApp (${reasonStr})`);
        return;
      }

      if (upper.includes('LOGOUT')) {
        console.warn(`[Account ${this.accountIndex}] LOGOUT détecté (téléphone délié) — nettoyage session pour nouveau QR.`);
        await this.resetSession();
        return;
      }

      this.phoneNumber = null;
      this.pushName = null;
      this.isInitializing = false;
      this.lastError = `Déconnecté: ${reasonStr}`;
      await this.updateStatus('DISCONNECTED', { qr_code_data_url: null });
      this.handleCrashRecovery(new Error(`Déconnecté: ${reasonStr}`));
    });
  }

  startBackupSchedule() {
    this.stopBackupSchedule();
    const interval = config.sessionBackup?.intervalMs || 600000;
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
    if (!this.client || !this.client.pupPage || this.client.pupPage.isClosed()) {
      throw new Error(`Navigateur pour la ligne ${this.accountIndex} fermé ou non prêt.`);
    }

    // Stealth patches
    try {
      await this.client.pupPage.evaluate(() => {
        try {
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
          if (!window.chrome) window.chrome = { runtime: {} };
          Object.defineProperty(navigator, 'languages', { get: () => ['fr-FR', 'fr', 'en-US', 'en'] });
        } catch {}
      });
    } catch {}

    let isReady = false;
    try {
      isReady = await this.client.pupPage.evaluate(() => {
        return Boolean(
          typeof window.WWebJS !== 'undefined' &&
            typeof window.WWebJS.getChat === 'function' &&
            typeof window.WWebJS.sendMessage === 'function'
        );
      });
    } catch {}

    if (isReady) return true;

    console.log(`[Account ${this.accountIndex}] 🔄 Re-injection window.WWebJS (ExposeAuthStore + LoadUtils)...`);
    try {
      await this.client.pupPage.evaluate(ExposeAuthStore).catch(() => {});
      await this.client.pupPage.evaluate(LoadUtils).catch(() => {});
      await new Promise(r => setTimeout(r, 400));
    } catch (e) {
      console.warn(`[Account ${this.accountIndex}] ensureInjected warning:`, e.message);
    }

    try {
      isReady = await this.client.pupPage.evaluate(() => {
        return Boolean(
          typeof window.WWebJS !== 'undefined' &&
            typeof window.WWebJS.getChat === 'function' &&
            typeof window.WWebJS.sendMessage === 'function'
        );
      });
    } catch {}

    return isReady;
  }

  async updateStatus(status, extra = {}) {
    this.status = status;
    try {
      await db.updateAccountStatus(this.accountIndex, status, extra);
    } catch (e) {
      console.error(`[Account ${this.accountIndex}] Mise à jour statut DB échouée:`, e.message);
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
    await this.restart();
  }

  async destroyBrowserOnly() {
    this.stopBackupSchedule();
    try {
      if (this.client) {
        const browser = this.client.pupBrowser;
        const pid = browser?.process?.()?.pid;
        await this.client.destroy().catch(() => {});
        if (pid && process.platform !== 'win32') {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {}
        }
        this.client = null;
      }
    } catch {}
    this.isInitializing = false;
    this.isBusy = false;
    cleanChromiumLocks(this.sessionPath);
  }

  async handleCrashRecovery(error) {
    if (this.isDestroyed || this.isRecovering || this.checkRestricted()) return;
    const errorStr = error?.message ? error.message : String(error);
    const isCrash = isCrashErrorMessage(errorStr);

    if (!isCrash && this.restartAttempts >= this.maxRestartAttempts) {
      console.error(`[Account ${this.accountIndex}] Nombre maximum de tentatives atteint (${this.maxRestartAttempts}).`);
      return;
    }

    this.isRecovering = true;
    this.restartAttempts = Math.min(this.maxRestartAttempts, this.restartAttempts + 1);
    console.warn(
      `[Account ${this.accountIndex}] Récupération automatique (tentative ${this.restartAttempts}/${this.maxRestartAttempts}) suite à: ${errorStr}`
    );

    try {
      await this.destroyBrowserOnly();
      cleanupTmpChromeDirs();
      const backoffMs = Math.min(20000, 2500 * Math.pow(1.4, this.restartAttempts));
      await new Promise(r => setTimeout(r, backoffMs));
      await this.initialize();
    } finally {
      this.isRecovering = false;
    }
  }

  async waitUntilFree(maxWaitMs = 12000) {
    const start = Date.now();
    while (this.isBusy) {
      if (Date.now() - start > maxWaitMs) {
        throw new Error(`La ligne ${this.accountIndex} est occupée à envoyer un autre message. Réessayez dans quelques secondes.`);
      }
      await new Promise(r => setTimeout(r, 300));
    }
  }

  async sendMessage({ to, text, pdfBase64 = null, pdfFileName = null, kind = 'receipt' }) {
    if (!this.isReady()) {
      throw new Error(`La ligne SIM ${this.accountIndex} n'est pas prête (Statut: ${this.status})`);
    }

    const cleanNumber = normalizePhoneDigits(to, config.securgym?.defaultCountryCode || '509');
    if (!cleanNumber || cleanNumber.length < 8) {
      throw new Error('Numéro destinataire invalide (minimum 8 chiffres).');
    }
    const chatId = `${cleanNumber}@c.us`;

    await this.waitUntilFree(12000);
    this.isBusy = true;

    try {
      await this.ensureInjected();

      // 1. Présence humaine
      try {
        await this.client.sendPresenceAvailable();
      } catch {}

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
            typingSimulationMs: isFastLane ? 1200 : 2500
          };
      const finalMessageText = shieldResult.processedText;

      // 2. Simulation de frappe
      try {
        const chat = await this.client.getChatById(chatId);
        if (chat) {
          await chat.sendStateTyping();
          await new Promise(resolve => setTimeout(resolve, shieldResult.typingSimulationMs));
          await chat.clearState();
        } else {
          await new Promise(resolve => setTimeout(resolve, 1200));
        }
      } catch {
        await new Promise(resolve => setTimeout(resolve, 1500));
      }

      // 3. Envoi PDF ou texte avec ré-injection automatique et gestion crash
      const sendOptionsBase = { sendSeen: false };
      const cleanPdfB64 = normalizePdfBase64(pdfBase64);
      let pdfName = String(pdfFileName || 'Recu.pdf').trim();
      if (cleanPdfB64 && !pdfName.toLowerCase().endsWith('.pdf')) {
        pdfName += '.pdf';
      }

      const executeSend = async () => {
        if (cleanPdfB64) {
          const media = new MessageMedia('application/pdf', cleanPdfB64, pdfName);
          return await this.client.sendMessage(chatId, media, {
            ...sendOptionsBase,
            caption: finalMessageText
          });
        }
        return await this.client.sendMessage(chatId, finalMessageText, sendOptionsBase);
      };

      let sentResult = null;
      try {
        sentResult = await executeSend();
      } catch (sendErr) {
        const errMsg = sendErr?.message ? sendErr.message : String(sendErr);

        // Self-heal missing WWebJS / getChat and retry once
        if (
          errMsg.includes('getChat') ||
          errMsg.includes('WWebJS') ||
          errMsg.includes('Cannot read properties of undefined')
        ) {
          console.warn(`[Account ${this.accountIndex}] Erreur "${errMsg}", re-injection WWebJS + nouvelle tentative...`);
          await this.ensureInjected();
          sentResult = await executeSend();
        } else if (isCrashErrorMessage(errMsg)) {
          console.warn(`[Account ${this.accountIndex}] Crash navigateur détecté: ${errMsg}. Relance automatique...`);
          this.status = 'DISCONNECTED';
          this.lastError = errMsg;
          setTimeout(() => this.handleCrashRecovery(sendErr), 1000);
          throw sendErr;
        } else if (
          errMsg.includes('401') ||
          errMsg.includes('403') ||
          errMsg.includes('rate-overlimit') ||
          errMsg.toLowerCase().includes('restricted')
        ) {
          await this.markRestricted(24, errMsg);
          throw new Error(`Ligne restreinte par WhatsApp: ${errMsg}`);
        } else if (cleanPdfB64) {
          // If PDF attachment itself caused a non-crash error, fall back to text delivery
          console.warn(`[Account ${this.accountIndex}] PDF échoué (${errMsg}), envoi du texte seul...`);
          sentResult = await this.client.sendMessage(chatId, finalMessageText, sendOptionsBase);
        } else {
          throw sendErr;
        }
      }

      // 4. Mise à jour compteurs partagés (en mémoire + DB CVISUAL)
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
        whatsappMessageId: sentResult?.id?._serialized || sentResult?.id?.id || null,
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
    if (s.includes('@')) return s;
    const digits = normalizePhoneDigits(s, config.securgym?.defaultCountryCode || '509');
    if (!digits || digits.length < 8) return null;
    return `${digits}@c.us`;
  }

  async listChats(limit = 35) {
    if (!this.isReady()) {
      throw new Error(`La ligne ${this.accountIndex} n'est pas connectée (Statut: ${this.status}).`);
    }
    await this.ensureInjected();
    const chats = await this.client.getChats();
    const sorted = (Array.isArray(chats) ? chats : [])
      .slice()
      .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))
      .slice(0, Math.max(1, Math.min(Number(limit) || 35, 80)));

    return sorted.map(c => {
      const id = c?.id?._serialized ? c.id._serialized : String(c?.id || '');
      const user = c?.id?.user ? c.id.user : id.split('@')[0];
      const lm = c?.lastMessage || null;
      return {
        id,
        name: c?.name || user,
        phone: user,
        isGroup: Boolean(c?.isGroup),
        unreadCount: Number(c?.unreadCount || 0),
        timestamp: Number(c?.timestamp || 0),
        lastMessage: lm
          ? {
              body: typeof lm.body === 'string' ? lm.body : '',
              fromMe: Boolean(lm.fromMe),
              timestamp: Number(lm.timestamp || c.timestamp || 0),
              type: lm.type || 'chat',
              hasMedia: Boolean(lm.hasMedia)
            }
          : null
      };
    });
  }

  async getChatMessages(rawChatId, limit = 50) {
    if (!this.isReady()) {
      throw new Error(`La ligne ${this.accountIndex} n'est pas connectée (Statut: ${this.status}).`);
    }
    const cid = this._normalizeChatId(rawChatId);
    if (!cid) throw new Error('Chat ID ou numéro invalide.');
    await this.ensureInjected();
    const maxCount = Math.max(1, Math.min(Number(limit) || 50, 100));

    let chat = null;
    try {
      chat = await this.client.getChatById(cid);
    } catch {}
    if (!chat) {
      const chats = await this.client.getChats();
      chat = (Array.isArray(chats) ? chats : []).find(
        c => c?.id && (c.id._serialized === cid || c.id.user === cid.split('@')[0])
      );
    }
    if (!chat) return [];

    const msgs = await chat.fetchMessages({ limit: maxCount });
    return (Array.isArray(msgs) ? msgs : []).map(m => ({
      id: m?.id?._serialized ? m.id._serialized : String(Date.now()),
      body: typeof m?.body === 'string' ? m.body : '',
      fromMe: Boolean(m?.fromMe),
      timestamp: Number(m?.timestamp || 0),
      type: m?.type || 'chat',
      hasMedia: Boolean(m?.hasMedia),
      author: m?.author || m?.from || '',
      ack: Number(m?.ack || 0)
    }));
  }

  async sendDirectChatMessage(rawChatId, message) {
    if (!this.isReady()) {
      throw new Error(`La ligne ${this.accountIndex} n'est pas connectée (Statut: ${this.status}).`);
    }
    const cid = this._normalizeChatId(rawChatId);
    if (!cid) throw new Error('Numéro destinataire invalide.');
    const cleanText = String(message || '').trim();
    if (!cleanText) throw new Error('Le message est vide.');

    await this.waitUntilFree(12000);
    this.isBusy = true;
    try {
      await this.ensureInjected();
      try {
        await this.client.sendPresenceAvailable();
      } catch {}

      let sent;
      try {
        sent = await this.client.sendMessage(cid, cleanText, { sendSeen: false });
      } catch (err) {
        const errMsg = err?.message ? err.message : String(err);
        if (errMsg.includes('getChat') || errMsg.includes('WWebJS')) {
          await this.ensureInjected();
          sent = await this.client.sendMessage(cid, cleanText, { sendSeen: false });
        } else {
          throw err;
        }
      }

      this.lastSentAt = Date.now();
      return {
        id: sent?.id?._serialized ? sent.id._serialized : String(Date.now()),
        body: cleanText,
        fromMe: true,
        timestamp: Number(sent?.timestamp || Math.floor(Date.now() / 1000)),
        type: 'chat',
        hasMedia: false,
        ack: Number(sent?.ack || 1)
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
    await this.destroyBrowserOnly();
    cleanupTmpChromeDirs();
    if (awaitInit) {
      await this.initialize();
    } else {
      this.initialize().catch(err => {
        console.error(`[Account ${this.accountIndex}] Erreur restart:`, err.message);
      });
    }
  }

  async resetSession({ awaitInit = true } = {}) {
    console.log(`[Account ${this.accountIndex}] Réinitialisation complète de la session...`);
    this.isDestroyed = false;
    this.stopBackupSchedule();

    try {
      if (this.client && this.isReady()) {
        await Promise.race([
          this.client.logout().catch(() => {}),
          new Promise(r => setTimeout(r, 3000))
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

    cleanupTmpChromeDirs();

    this.rawQrCode = null;
    this.qrCodeDataUrl = null;
    this.phoneNumber = null;
    this.pushName = null;
    this.lastError = null;
    this.restrictedUntil = null;
    this.restrictionReason = null;

    await this.updateStatus('DISCONNECTED', {
      phone_number: null,
      qr_code_data_url: null,
      restricted_until: null
    });

    if (awaitInit) {
      await this.initialize();
    } else {
      this.initialize().catch(err => {
        console.error(`[Account ${this.accountIndex}] Erreur resetSession:`, err.message);
      });
    }
  }
}
