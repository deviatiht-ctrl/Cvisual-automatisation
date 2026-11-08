import pkg from 'whatsapp-web.js';
const { Client, LocalAuth, MessageMedia } = pkg;
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { db } from '../database.js';
import { config } from '../config.js';
import { applySpintaxAndHashShield } from '../shield.js';

const MODERN_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

// Cache latest WhatsApp Web HTML version from wppconnect-team
let cachedRemoteVersionUrl = null;

async function resolveLatestWaVersion() {
  if (cachedRemoteVersionUrl) return cachedRemoteVersionUrl;
  try {
    const response = await fetch('https://api.github.com/repos/wppconnect-team/wa-version/contents/html', {
      headers: { 'User-Agent': 'NodeJS-WA-Gateway' },
      signal: AbortSignal.timeout(6000)
    });
    if (response.ok) {
      const files = await response.json();
      if (Array.isArray(files) && files.length > 0) {
        // Sort files to find the newest HTML version
        const htmlFiles = files
          .map(f => f.name)
          .filter(n => n.endsWith('.html'))
          .sort();
        const latestFile = htmlFiles[htmlFiles.length - 1];
        if (latestFile) {
          cachedRemoteVersionUrl = `https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/${latestFile}`;
          console.log(`[WhatsApp Engine] Resolved latest remote WhatsApp Web version: ${latestFile}`);
          return cachedRemoteVersionUrl;
        }
      }
    }
  } catch (err) {
    console.warn('[WhatsApp Engine] Notice: Could not fetch GitHub wa-version repository (using remote fallback):', err.message);
  }
  // Safe default fallback
  return 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1018940866-alpha.html';
}

/**
 * Removes lingering Chromium lock files that cause "SingletonLock" and startup crashes
 */
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
            console.log(`[WhatsApp Engine] Removed stale Chromium lock file: ${fullPath}`);
          } catch (e) {
            // Ignore if in use
          }
        }
      }
    } catch (e) {
      // Directory access issue
    }
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

    // Clean any prior dangling locks
    cleanChromiumLocks(this.sessionPath);

    const remoteWaPath = await resolveLatestWaVersion();

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
          remotePath: remoteWaPath
        },
        puppeteer: puppeteerOptions
      });

      this.setupEventHandlers();
      await this.client.initialize();
      this.isInitializing = false;
    } catch (error) {
      console.error(`[Account ${this.accountIndex}] Initialization failure:`, error.message);
      this.updateStatus('ERROR', { error_message: error.message });
      this.isInitializing = false;
      this.handleCrashRecovery(error);
    }
  }

  setupEventHandlers() {
    this.client.on('qr', async (qr) => {
      // Generate inline data URL using standard QR matrix or Google Chart / simple SVG data url
      // For immediate preview without external heavy canvas, we create an SVG Data URL or API string
      const qrDataUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`;
      this.qrCodeDataUrl = qrDataUrl;
      this.updateStatus('SCAN_QR', { qr_code_data_url: qrDataUrl });
      console.log(`[Account ${this.accountIndex}] QR Code generated! Ready to scan.`);
      this.emit('qr', { accountIndex: this.accountIndex, qr, qrDataUrl });
    });

    this.client.on('authenticated', () => {
      console.log(`[Account ${this.accountIndex}] WhatsApp Session Authenticated.`);
      this.qrCodeDataUrl = null;
      this.updateStatus('AUTHENTICATED', { qr_code_data_url: null });
      this.restartAttempts = 0;
      this.emit('authenticated', { accountIndex: this.accountIndex });
    });

    this.client.on('auth_failure', (msg) => {
      console.error(`[Account ${this.accountIndex}] WhatsApp Auth Failure:`, msg);
      this.updateStatus('ERROR', { error_message: msg });
      this.emit('auth_failure', { accountIndex: this.accountIndex, msg });
    });

    this.client.on('ready', async () => {
      try {
        const info = this.client.info;
        this.phoneNumber = info?.wid?.user || 'Unknown';
        console.log(`[Account ${this.accountIndex}] WhatsApp Line READY. Phone: ${this.phoneNumber}`);
        this.updateStatus('READY', {
          phone_number: this.phoneNumber,
          qr_code_data_url: null
        });

        // Stealth injection into active browser page
        if (this.client.pupPage) {
          await this.client.pupPage.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
          }).catch(() => {});
        }

        this.emit('ready', { accountIndex: this.accountIndex, phoneNumber: this.phoneNumber });
      } catch (err) {
        console.error(`[Account ${this.accountIndex}] Ready handler error:`, err.message);
      }
    });

    this.client.on('disconnected', async (reason) => {
      console.warn(`[Account ${this.accountIndex}] Disconnected: ${reason}`);
      this.updateStatus('DISCONNECTED', { qr_code_data_url: null });
      this.emit('disconnected', { accountIndex: this.accountIndex, reason });
      this.handleCrashRecovery(new Error(`Disconnected: ${reason}`));
    });
  }

  async updateStatus(status, extra = {}) {
    this.status = status;
    try {
      await db.updateAccountStatus(this.accountIndex, status, extra);
    } catch (e) {
      console.error(`[Account ${this.accountIndex}] Could not update status in DB:`, e.message);
    }
  }

  isReady() {
    return this.status === 'READY' && this.client !== null;
  }

  /**
   * Auto-Recovery upon Chromium target crashes or execution context destruction
   */
  async handleCrashRecovery(error) {
    const errorStr = (error && error.message) ? error.message : String(error);
    const isTargetCrash = errorStr.includes('Execution context was destroyed') ||
                          errorStr.includes('Target closed') ||
                          errorStr.includes('Session closed') ||
                          errorStr.includes('Disconnected');

    if (!isTargetCrash && this.restartAttempts >= this.maxRestartAttempts) {
      console.error(`[Account ${this.accountIndex}] Max restart attempts reached. Manual reset needed.`);
      return;
    }

    this.restartAttempts++;
    console.warn(`[Account ${this.accountIndex}] Triggering Auto-Recovery (attempt ${this.restartAttempts}/${this.maxRestartAttempts})...`);

    try {
      if (this.client) {
        await this.client.destroy().catch(() => {});
        this.client = null;
      }
    } catch (e) {
      // Ignore
    }

    cleanChromiumLocks(this.sessionPath);

    // Exponential backoff wait before restart
    const backoffMs = Math.min(30000, 3000 * Math.pow(1.5, this.restartAttempts));
    await new Promise(r => setTimeout(r, backoffMs));

    await this.initialize();
  }

  /**
   * Sends a message with Human Presence Simulation & Anti-Ban Protection
   */
  async sendMessage({ to, text, pdfBase64 = null, pdfFileName = null, kind = 'receipt' }) {
    if (!this.isReady()) {
      throw new Error(`Account SIM ${this.accountIndex} is not ready (Status: ${this.status})`);
    }

    // Format destination WhatsApp JID (E.164 without +, e.g. 50931234567@c.us)
    const cleanNumber = to.replace(/\D/g, '');
    const chatId = `${cleanNumber}@c.us`;

    // 1. HUMAN PRESENCE SIMULATION:
    // Siyal sendPresenceAvailable()
    try {
      await this.client.sendPresenceAvailable();
    } catch (e) {
      // Non-blocking
    }

    // Shield payload calculation
    const isReminder = ['reminder', 'marketing'].includes(kind);
    const shieldResult = applySpintaxAndHashShield(text, { forceEngagement: isReminder });
    const finalMessageText = shieldResult.processedText;

    // 2. Human typing simulation (2 to 4 seconds)
    try {
      const chat = await this.client.getChatById(chatId);
      if (chat) {
        await chat.sendStateTyping();
        await new Promise(resolve => setTimeout(resolve, shieldResult.typingSimulationMs));
        await chat.clearState();
      }
    } catch (err) {
      // Fallback typing delay if chat object resolution fails
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    // 3. Dispatch: PDF Media or Text
    let sentResult = null;
    if (pdfBase64) {
      const media = new MessageMedia(
        'application/pdf',
        pdfBase64,
        pdfFileName || 'Document.pdf'
      );
      sentResult = await this.client.sendMessage(chatId, media, { caption: finalMessageText });
    } else {
      sentResult = await this.client.sendMessage(chatId, finalMessageText);
    }

    // 4. Update usage stats
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

  /**
   * Reset session: Wipes auth files to allow fresh QR scan
   */
  async resetSession() {
    console.log(`[Account ${this.accountIndex}] Resetting session completely...`);
    try {
      if (this.client) {
        await this.client.logout().catch(() => {});
        await this.client.destroy().catch(() => {});
        this.client = null;
      }
    } catch (e) {
      // Ignore
    }

    // Wipe session storage directory
    try {
      if (fs.existsSync(this.sessionPath)) {
        fs.rmSync(this.sessionPath, { recursive: true, force: true });
        console.log(`[Account ${this.accountIndex}] Removed session folder: ${this.sessionPath}`);
      }
    } catch (err) {
      console.warn(`[Account ${this.accountIndex}] Session folder removal warning:`, err.message);
    }

    this.qrCodeDataUrl = null;
    this.phoneNumber = null;
    await this.updateStatus('DISCONNECTED', {
      phone_number: null,
      qr_code_data_url: null
    });

    // Re-initialize immediately for new QR
    await this.initialize();
  }
}
