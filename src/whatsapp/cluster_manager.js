import { WhatsAppAccountInstance, cleanupTmpChromeDirs, normalizePhoneDigits } from './account_instance.js';
import { db } from '../database.js';
import { config } from '../config.js';

export class ClusterManager {
  constructor() {
    this.accounts = new Map(); // accountIndex -> WhatsAppAccountInstance
    this.isFastLaneRunning = false;
    this.isSlowLaneRunning = false;
    this.fastLaneTimeout = null;
    this.slowLaneTimeout = null;
    this.batchPauseMap = new Map(); // accountIndex -> timestamp when pause expires
    this.nextSlowLaneAllowedAt = new Map(); // accountIndex -> timestamp
  }

  async initializeCluster() {
    console.log(
      `[Cluster Manager] Initializing WhatsApp Cluster (maxConcurrentAccounts=${config.maxConcurrentAccounts})...`
    );
    cleanupTmpChromeDirs();

    let dbAccounts = await db.listAccounts();

    if (!dbAccounts || dbAccounts.length === 0) {
      await db.createOrUpdateAccount({
        account_index: 1,
        label: 'Liy Prensipal 1',
        daily_reminder_limit: config.engine.slowLane.dailyReminderLimit,
        is_enabled: true
      });
      dbAccounts = await db.listAccounts();
    }

    const enabled = (dbAccounts || [])
      .filter(a => a.is_enabled !== false)
      .sort((a, b) => a.account_index - b.account_index);

    const primary = enabled.find(a => a.account_index === (config.securgym?.accountIndex || 1)) || enabled[0] || {
      account_index: config.securgym?.accountIndex || 1,
      label: 'Liy Prensipal 1'
    };

    const toStart = [primary];
    for (const acc of enabled) {
      if (toStart.length >= config.maxConcurrentAccounts) break;
      if (acc.account_index !== primary.account_index) {
        toStart.push(acc);
      }
    }

    // Register managed instances synchronously so status/reset routes never miss them at startup
    const registered = [];
    for (const acc of toStart) {
      const idx = parseInt(acc.account_index, 10);
      if (!this.accounts.has(idx) && this.accounts.size < config.maxConcurrentAccounts) {
        registered.push(new WhatsAppAccountInstance(idx, acc.label || `Liy ${idx}`));
        this.accounts.set(idx, registered[registered.length - 1]);
      }
    }

    // Launch headless Chromium slightly after HTTP server finishes binding
    setTimeout(() => {
      for (const instance of registered) {
        instance.initialize().catch(err => {
          console.error(`[Cluster Manager] Error during initialization of Account ${instance.accountIndex}:`, err.message);
        });
      }
    }, 1500);

    // Start CVISUAL multi-tenant dual-lane background processors
    this.startDualLaneEngines();
  }

  async registerAndStartAccount(accountIndex, label) {
    const idx = parseInt(accountIndex, 10);
    if (this.accounts.has(idx)) {
      return this.accounts.get(idx);
    }

    if (this.accounts.size >= config.maxConcurrentAccounts) {
      console.warn(
        `[Cluster Manager] Blocked spawning Account ${idx}: maxConcurrentAccounts (${config.maxConcurrentAccounts}) limit active to prevent OOM.`
      );
      return null;
    }

    const instance = new WhatsAppAccountInstance(idx, label);
    this.accounts.set(idx, instance);

    instance.initialize().catch(err => {
      console.error(`[Cluster Manager] Error during initialization of Account ${idx}:`, err.message);
    });

    return instance;
  }

  // Strictly NO lazy Chromium spawning here (avoids accidental OOM on GET QR/status polls)
  getAccount(accountIndex) {
    const idx = parseInt(accountIndex, 10);
    return this.accounts.get(idx) || null;
  }

  getAllAccounts() {
    return Array.from(this.accounts.values()).sort((a, b) => a.accountIndex - b.accountIndex);
  }

  getPrimaryReadyAccount() {
    const ready = this.getAllAccounts().filter(a => a.isReady());
    if (ready.length === 0) return null;
    ready.sort((a, b) => (a.lastSentAt || 0) - (b.lastSentAt || 0));
    return ready[0];
  }

  async addAccount(accountIndex, label = `SIM ${accountIndex}`) {
    const idx = parseInt(accountIndex, 10);
    await db.createOrUpdateAccount({
      account_index: idx,
      label,
      daily_reminder_limit: config.engine.slowLane.dailyReminderLimit,
      is_enabled: true
    });
    const inst = await this.registerAndStartAccount(idx, label);
    if (!inst) {
      return { status: 'QUEUED_STANDBY', account_index: idx, label };
    }
    return inst;
  }

  async restartAccount(accountIndex, { awaitInit = true } = {}) {
    const idx = parseInt(accountIndex, 10);
    let instance = this.getAccount(idx);
    if (!instance && this.accounts.size < config.maxConcurrentAccounts) {
      instance = await this.registerAndStartAccount(idx, `SIM Liy ${idx}`);
      return { ok: true, message: `Account ${idx} initializing.` };
    }
    if (!instance) {
      throw new Error(`Account ${idx} is not running in this worker (maxConcurrentAccounts=${config.maxConcurrentAccounts}).`);
    }
    await instance.restart({ awaitInit });
    return { ok: true, message: `Account ${idx} restarted successfully.` };
  }

  async resetAccount(accountIndex, { awaitInit = true } = {}) {
    const idx = parseInt(accountIndex, 10);
    const instance = this.getAccount(idx);
    if (!instance) {
      throw new Error(`Account ${idx} not found in active cluster.`);
    }
    await instance.resetSession({ awaitInit });
    return { ok: true, message: `Account ${idx} session reset successfully.` };
  }

  async unrestrictAccount(accountIndex) {
    const idx = parseInt(accountIndex, 10);
    const instance = this.getAccount(idx);
    if (!instance) {
      throw new Error(`Account ${idx} not found in active cluster.`);
    }
    await instance.unrestrict();
    return { ok: true, message: `Account ${idx} unrestricted.` };
  }

  /**
   * Direct immediate dispatch for Fast Lane HTTP endpoints (/api/send, /api/test)
   */
  async sendMessageAnywhere({ to, message, pdfBase64 = null, pdfFileName = null, kind = 'test' }) {
    const cleanPhone = normalizePhoneDigits(to, config.securgym?.defaultCountryCode || '509');
    if (!cleanPhone || cleanPhone.length < 8) {
      throw new Error('Numéro destinataire invalide (minimum 8 chiffres).');
    }

    // Wait briefly up to 8s if a ready line is temporarily busy finishing an ongoing send
    let chosen = null;
    for (let attempt = 0; attempt < 16; attempt++) {
      const readyAccounts = this.getAllAccounts().filter(a => a.isReady() && !a.isBusy);
      if (readyAccounts.length > 0) {
        readyAccounts.sort((a, b) => (a.lastSentAt || 0) - (b.lastSentAt || 0));
        chosen = readyAccounts[0];
        break;
      }
      const anyReady = this.getAllAccounts().some(a => a.isReady());
      if (!anyReady) break;
      await new Promise(r => setTimeout(r, 500));
    }

    if (!chosen) {
      throw new Error('Okenn liy WhatsApp pa pare oswa konekte pou voye mesaj kounye a.');
    }

    const result = await chosen.sendMessage({
      to: cleanPhone,
      text: String(message || '').trim(),
      pdfBase64,
      pdfFileName,
      kind
    });

    return {
      ...result,
      to: cleanPhone,
      accountIndex: chosen.accountIndex,
      fromPhone: chosen.phoneNumber
    };
  }

  /**
   * LRU (Least Recently Used) SIM Selection for Fast Lane
   * Fast Lane bypasses 25/day reminder limit completely!
   */
  async selectFastLaneAccount() {
    const readyAccounts = [];

    for (const [idx, inst] of this.accounts.entries()) {
      if (inst.isReady() && !inst.isBusy) {
        const dbAcc = await db.getAccountByIndex(idx);
        const lastMem = inst.lastSentAt || 0;
        const lastDb = dbAcc?.last_sent_at ? new Date(dbAcc.last_sent_at).getTime() : 0;
        readyAccounts.push({
          instance: inst,
          dbRecord: dbAcc,
          lastSentAt: Math.max(lastMem, lastDb)
        });
      }
    }

    if (readyAccounts.length === 0) return null;

    readyAccounts.sort((a, b) => a.lastSentAt - b.lastSentAt);
    return readyAccounts[0].instance;
  }

  /**
   * LRU Selection for Slow Lane (Reminders & Marketing)
   * Strictly enforces:
   * 1. Max 25 reminders/day/SIM
   * 2. Batch pause (10 min after every 5 reminders)
   * 3. 10-16 min interval since last reminder
   */
  async selectSlowLaneAccount() {
    const now = Date.now();
    const eligibleAccounts = [];

    for (const [idx, inst] of this.accounts.entries()) {
      if (!inst.isReady() || inst.isBusy) continue;

      const dbAcc = await db.getAccountByIndex(idx);
      const sentToday = Math.max(dbAcc?.sent_reminders_today || 0, inst.sentRemindersToday || 0);
      const limit = dbAcc?.daily_reminder_limit || config.engine.slowLane.dailyReminderLimit;
      if (sentToday >= limit) {
        continue;
      }

      const pausedUntil = this.batchPauseMap.get(idx) || 0;
      const nextAllowed = this.nextSlowLaneAllowedAt.get(idx) || 0;
      if (now < pausedUntil || now < nextAllowed) {
        continue;
      }

      // Leave small buffer after Fast Lane activity so reminder doesn't burst immediately after receipt
      if (inst.lastSentAt && now - inst.lastSentAt < 15000) {
        continue;
      }

      eligibleAccounts.push({
        instance: inst,
        dbRecord: dbAcc || {},
        lastReminderSentAt: Math.max(
          dbAcc?.last_reminder_sent_at ? new Date(dbAcc.last_reminder_sent_at).getTime() : 0,
          inst.lastReminderSentAt || 0
        )
      });
    }

    if (eligibleAccounts.length === 0) return null;

    eligibleAccounts.sort((a, b) => a.lastReminderSentAt - b.lastReminderSentAt);
    return eligibleAccounts[0];
  }

  startDualLaneEngines() {
    this.isFastLaneRunning = true;
    this.isSlowLaneRunning = true;

    console.log('[Dual-Lane Engine] Starting CVISUAL Fast Lane & Slow Lane schedulers...');
    this.processFastLaneLoop();
    this.processSlowLaneLoop();
  }

  async processFastLaneLoop() {
    if (!this.isFastLaneRunning) return;

    try {
      const msg = await db.fetchNextPendingFastLane();
      if (msg) {
        const account = await this.selectFastLaneAccount();
        if (account) {
          await db.updateMessageStatus(msg.id, 'processing', {
            assignedAccountIndex: account.accountIndex
          });

          const delayMs =
            Math.floor(Math.random() * (config.engine.fastLane.maxDelayMs - config.engine.fastLane.minDelayMs + 1)) +
            config.engine.fastLane.minDelayMs;

          await new Promise(r => setTimeout(r, delayMs));

          try {
            await account.sendMessage({
              to: msg.to_phone,
              text: msg.message,
              pdfBase64: msg.pdf_base64,
              pdfFileName: msg.pdf_file_name,
              kind: msg.kind
            });

            await db.updateMessageStatus(msg.id, 'sent', {
              sentByPhone: account.phoneNumber,
              sentAt: new Date().toISOString(),
              errorMessage: null
            });

            console.log(`[Fast Lane] Sent message ${msg.id} to ${msg.to_phone} via Line ${account.accountIndex}`);
          } catch (sendErr) {
            console.error(`[Fast Lane] Failed sending ${msg.id}:`, sendErr.message);
            await db.incrementMessageRetryOrFail(msg.id, sendErr.message, 5);
          }
        }
      }
    } catch (loopErr) {
      console.error('[Fast Lane Loop Error]:', loopErr.message);
    }

    if (this.isFastLaneRunning) {
      this.fastLaneTimeout = setTimeout(() => this.processFastLaneLoop(), 2000);
    }
  }

  async processSlowLaneLoop() {
    if (!this.isSlowLaneRunning) return;

    let nextIntervalMs = 15000;

    try {
      const msg = await db.fetchNextPendingSlowLane();
      if (msg) {
        const eligible = await this.selectSlowLaneAccount();
        if (eligible) {
          const { instance, dbRecord } = eligible;
          const accountIndex = instance.accountIndex;

          await db.updateMessageStatus(msg.id, 'processing', {
            assignedAccountIndex: accountIndex
          });

          try {
            console.log(`[Slow Lane] Processing message ${msg.id} (${msg.kind}) via Line ${accountIndex}...`);
            await instance.sendMessage({
              to: msg.to_phone,
              text: msg.message,
              kind: msg.kind
            });

            await db.updateMessageStatus(msg.id, 'sent', {
              sentByPhone: instance.phoneNumber,
              sentAt: new Date().toISOString(),
              errorMessage: null
            });

            const newConsecutive = (dbRecord.consecutive_reminders_count || 0) + 1;
            if (newConsecutive >= config.engine.slowLane.batchPauseThreshold) {
              const pauseUntil = Date.now() + config.engine.slowLane.batchPauseDurationMs;
              this.batchPauseMap.set(accountIndex, pauseUntil);
              await db.resetConsecutiveReminders(accountIndex);
              console.log(`[Slow Lane] Line ${accountIndex} hit batch pause threshold. Cooling down 10 min.`);
            }

            const jitter = Math.floor(Math.random() * config.engine.slowLane.maxJitterMs);
            nextIntervalMs = config.engine.slowLane.minIntervalMs + jitter;
            this.nextSlowLaneAllowedAt.set(accountIndex, Date.now() + nextIntervalMs);
            console.log(`[Slow Lane] Next message allowed in ${Math.round(nextIntervalMs / 60000)} minutes.`);
          } catch (sendErr) {
            console.error(`[Slow Lane] Failed sending ${msg.id}:`, sendErr.message);
            await db.incrementMessageRetryOrFail(msg.id, sendErr.message, 5);
            nextIntervalMs = 20000;
          }
        } else {
          nextIntervalMs = 30000;
        }
      } else {
        nextIntervalMs = 10000;
      }
    } catch (err) {
      console.error('[Slow Lane Loop Error]:', err.message);
      nextIntervalMs = 15000;
    }

    if (this.isSlowLaneRunning) {
      this.slowLaneTimeout = setTimeout(() => this.processSlowLaneLoop(), nextIntervalMs);
    }
  }

  stop() {
    this.isFastLaneRunning = false;
    this.isSlowLaneRunning = false;
    if (this.fastLaneTimeout) clearTimeout(this.fastLaneTimeout);
    if (this.slowLaneTimeout) clearTimeout(this.slowLaneTimeout);
    for (const acc of this.accounts.values()) {
      acc.isDestroyed = true;
      acc.stopBackupSchedule();
    }
  }
}

export const clusterManager = new ClusterManager();
