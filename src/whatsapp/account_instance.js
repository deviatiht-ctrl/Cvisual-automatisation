import pkg from 'whatsapp-web.js';
const { Client, LocalAuth, MessageMedia } = pkg;
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import QRCode from 'qrcode';
import { db } from '../database.js';
import { config } from '../config.js';
import { applySpintaxAndHashShield } from '../shield.js';

const MODERN_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

// Stable remote WhatsApp Web HTML version (immediate fallback, no blocking GitHub API delay)
const STABLE_REMOTE_WA_URL = 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1018940866-alpha.html';
let cachedRemoteVersionUrl = STABLE_REMOTE_WA_URL;

// Asynchronously check for newer version in background without blocking startup
(async () => {
  try {
    const res = await fetch('https://api.github.com/repos/wppconnect-team/wa-version/contents/html', {
      headers: { 'User-Agent': 'NodeJS-WA-Gateway' },
      signal: AbortSignal.timeout(3000)
    });
    if (res.ok) {
      const files = await res.json();
      if (Array.isArray(files) && files.length > 0) {
        const htmlFiles = files
          .map(f => f.name)
          .filter(n => n.endsWith('.html'))
          .sort();
        const latest = htmlFiles[htmlFiles.length - 1];
        if (latest) {
          cachedRemoteVersionUrl = `https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/${latest}`;
        }
      }
    }
  } catch (e) {
    // Keep stable version
  }
})();

function cleanChromiumLocks(sessionDir) {
  if (!fs.existsSync(sessionDir)) return;
  const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort'];

  const walkAndClean = (dir) => {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkAndClean(fullPath);
        } else if (lockFiles.includes(entry.name)) {
          try {
            fs.unlinkSync(fullPath);
          } catch (e) {}
        }
      }
    } catch (e) {}
  };

  walkAndClean(sessionDir);
}

export class WhatsAppAccountInstance extends EventEmitter {
  constructor(accountIndex, label = `SIM ${accountIndex}`) {
    super();
    this.accountIndex = parseInt(accountIndex, 10);
    this.label = label;
    this.client = null;
    this.status = 'DISCONNECTED';
    this.phoneNumber = null;
    this.qrCodeDataUrl = null;
    this.isInitializing = false;
    this.restartAttempts = 0;
    this.maxRestartAttempts = 5;
    this.sessionPath = path.join(config.authDataDir, `session-account-${this.accountIndex}`);
  }

  async initialize() {
    if (this.isInitializing) return;
    this.isInitializing = true;
    this.updateStatus('INITIALIZING');

    // Clean prior dangling locks
    cleanChromiumLocks(this.sessionPath);

    const puppeteerArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-blink-features=AutomationControlled',
      '--hide-scrollbars',
      '--mute-audio',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--js-flags=--max-old-space-size=256'
    ];

    const puppeteerOptions = {
      headless: config.puppeteer.headless,
      args: puppeteerArgs,
      userAgent: MODERN_USER_AGENT
    };

    if (config.puppeteer.executablePath) {
      puppeteerOptions.executablePath = config.puppeteer.executablePath;
    }

    try {
      this.client = new Client({
        authStrategy: new LocalAuth({
          clientId: `account-${this.accountIndex}`,
          dataPath: config.authDataDir
        }),
        webVersionCache: {
          type: 'remote',
          remotePath: cachedRemoteVersionUrl
        },
        puppeteer: puppeteerOptions
      });

      this.setupEventHandlers();
      await this.client.initialize();
      this.isInitializing = false;
    } catch (error) {
      console.error(`[Account ${this.accountIndex}] Erreur d'initialisation:`, error.message);
      this.updateStatus('ERROR', { error_message: error.message });
      this.isInitializing = false;
      this.handleCrashRecovery(error);
    }
  }

  setupEventHandlers() {
    this.client.on('qr', async (qr) => {
      try {
        // Fast instant local QR Code generation (in-memory Base64, 0.005s)
        const qrDataUrl = await QRCode.toDataURL(qr, {
          width: 300,
          margin: 2,
          color: {
            dark: '#0f172a',
            light: '#ffffff'
          }
        });
        this.qrCodeDataUrl = qrDataUrl;
        this.updateStatus('SCAN_QR', { qr_code_data_url: qrDataUrl });
        console.log(`[Account ${this.accountIndex}] QR Code généré instantanément! Prêt à scanner.`);
        this.emit('qr', { accountIndex: this.accountIndex, qr, qrDataUrl });
      } catch (err) {
        console.error(`[Account ${this.accountIndex}] Erreur génération QR:`, err.message);
      }
    });

    this.client.on('authenticated', () => {
      console.log(`[Account ${this.accountIndex}] Session WhatsApp authentifiée avec succès.`);
      this.qrCodeDataUrl = null;
      this.updateStatus('AUTHENTICATED', { qr_code_data_url: null });
      this.restartAttempts = 0;
      this.emit('authenticated', { accountIndex: this.accountIndex });
    });

    this.client.on('auth_failure', (msg) => {
      console.error(`[Account ${this.accountIndex}] Échec d'authentification:`, msg);
      this.updateStatus('ERROR', { error_message: msg });
      this.emit('auth_failure', { accountIndex: this.accountIndex, msg });
    });

    this.client.on('ready', async () => {
      try {
        const info = this.client.info;
        this.phoneNumber = info?.wid?.user || 'Connecté';
        console.log(`[Account ${this.accountIndex}] Ligne WhatsApp PRÊTE (READY). Numéro: ${this.phoneNumber}`);
        this.updateStatus('READY', {
          phone_number: this.phoneNumber,
          qr_code_data_url: null
        });

        // Stealth mode
        if (this.client.pupPage) {
          await this.client.pupPage.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
          }).catch(() => {});
        }

        this.emit('ready', { accountIndex: this.accountIndex, phoneNumber: this.phoneNumber });
      } catch (err) {
        console.error(`[Account ${this.accountIndex}] Erreur ready handler:`, err.message);
      }
    });

    this.client.on('disconnected', async (reason) => {
      console.warn(`[Account ${this.accountIndex}] Ligne déconnectée: ${reason}`);
      this.updateStatus('DISCONNECTED', { qr_code_data_url: null });
      this.emit('disconnected', { accountIndex: this.accountIndex, reason });
      this.handleCrashRecovery(new Error(`Déconnecté: ${reason}`));
    });
  }

  async updateStatus(status, extra = {}) {
    this.status = status;
    try {
      await db.updateAccountStatus(this.accountIndex, status, extra);
    } catch (e) {
      console.error(`[Account ${this.accountIndex}] Mise à jour statut DB échouée:`, e.message);
    }
  }

  isReady() {
    return this.status === 'READY' && this.client !== null;
  }

  async handleCrashRecovery(error) {
    const errorStr = (error && error.message) ? error.message : String(error);
    const isTargetCrash = errorStr.includes('Execution context was destroyed') ||
                          errorStr.includes('Target closed') ||
                          errorStr.includes('Session closed') ||
                          errorStr.includes('Déconnecté');

    if (!isTargetCrash && this.restartAttempts >= this.maxRestartAttempts) {
      console.error(`[Account ${this.accountIndex}] Nombre maximum de tentatives de redémarrage atteint.`);
      return;
    }

    this.restartAttempts++;
    console.warn(`[Account ${this.accountIndex}] Déclenchement récupération automatique (tentative ${this.restartAttempts}/${this.maxRestartAttempts})...`);

    try {
      if (this.client) {
        await this.client.destroy().catch(() => {});
        this.client = null;
      }
    } catch (e) {}

    cleanChromiumLocks(this.sessionPath);

    const backoffMs = Math.min(20000, 2000 * Math.pow(1.5, this.restartAttempts));
    await new Promise(r => setTimeout(r, backoffMs));

    await this.initialize();
  }

  async sendMessage({ to, text, pdfBase64 = null, pdfFileName = null, kind = 'receipt' }) {
    if (!this.isReady()) {
      throw new Error(`La ligne SIM ${this.accountIndex} n'est pas prête (Statut: ${this.status})`);
    }

    const cleanNumber = to.replace(/\D/g, '');
    const chatId = `${cleanNumber}@c.us`;

    // 1. Présence humaine
    try {
      await this.client.sendPresenceAvailable();
    } catch (e) {}

    const isReminder = ['reminder', 'marketing'].includes(kind);
    const shieldResult = applySpintaxAndHashShield(text, { forceEngagement: isReminder });
    const finalMessageText = shieldResult.processedText;

    // 2. Simulation de frappe (typing)
    try {
      const chat = await this.client.getChatById(chatId);
      if (chat) {
        await chat.sendStateTyping();
        await new Promise(resolve => setTimeout(resolve, shieldResult.typingSimulationMs));
        await chat.clearState();
      }
    } catch (err) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    // 3. Envoi PDF ou texte
    let sentResult = null;
    if (pdfBase64) {
      const media = new MessageMedia(
        'application/pdf',
        pdfBase64,
        pdfFileName || 'Facture.pdf'
      );
      sentResult = await this.client.sendMessage(chatId, media, { caption: finalMessageText });
    } else {
      sentResult = await this.client.sendMessage(chatId, finalMessageText);
    }

    // 4. Mise à jour compteurs
    await db.incrementAccountSent(this.accountIndex, isReminder);

    return {
      success: true,
      whatsappMessageId: sentResult?.id?.id || null,
      shield: {
        originalHash: shieldResult.originalHash,
        shieldedHash: shieldResult.shieldedHash,
        injectedCount: shieldResult.injectedCount,
        typingMs: shieldResult.typingSimulationMs
      }
    };
  }

  async resetSession() {
    console.log(`[Account ${this.accountIndex}] Réinitialisation complète de la session...`);
    try {
      if (this.client) {
        await this.client.logout().catch(() => {});
        await this.client.destroy().catch(() => {});
        this.client = null;
      }
    } catch (e) {}

    try {
      if (fs.existsSync(this.sessionPath)) {
        fs.rmSync(this.sessionPath, { recursive: true, force: true });
      }
    } catch (err) {
      console.warn(`[Account ${this.accountIndex}] Avertissement suppression dossier session:`, err.message);
    }

    this.qrCodeDataUrl = null;
    this.phoneNumber = null;
    await this.updateStatus('DISCONNECTED', {
      phone_number: null,
      qr_code_data_url: null
    });

    await this.initialize();
  }
}
