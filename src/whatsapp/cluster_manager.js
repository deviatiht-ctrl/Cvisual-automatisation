import { WhatsAppAccountInstance } from './account_instance.js';
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
  }

  async initializeCluster() {
    console.log('[Cluster Manager] Initializing WhatsApp Accounts Cluster...');
    let dbAccounts = await db.listAccounts();

    if (!dbAccounts || dbAccounts.length === 0) {
      // Seed account 1
      await db.createOrUpdateAccount({
        account_index: 1,
        label: 'Liy Prensipal 1',
        daily_reminder_limit: config.engine.slowLane.dailyReminderLimit
      });
      dbAccounts = await db.listAccounts();
    }

    for (const acc of dbAccounts) {
      if (acc.is_enabled) {
        await this.registerAndStartAccount(acc.account_index, acc.label);
      }
    }

    // Start dual-lane background processors
    this.startDualLaneEngines();
  }

  async registerAndStartAccount(accountIndex, label) {
    const idx = parseInt(accountIndex, 10);
    if (this.accounts.has(idx)) {
      return this.accounts.get(idx);
    }

    const instance = new WhatsAppAccountInstance(idx, label);
    this.accounts.set(idx, instance);

    // Asynchronously initialize without blocking entire server startup
    instance.initialize().catch(err => {
      console.error(`[Cluster Manager] Error during initialization of Account ${idx}:`, err.message);
    });

    return instance;
  }

  getAccount(accountIndex) {
    return this.accounts.get(parseInt(accountIndex, 10)) || null;
  }

  getAllAccounts() {
    return Array.from(this.accounts.values());
  }

  async addAccount(accountIndex, label = `SIM ${accountIndex}`) {
    const idx = parseInt(accountIndex, 10);
    await db.createOrUpdateAccount({
      account_index: idx,
      label,
      daily_reminder_limit: config.engine.slowLane.dailyReminderLimit,
      is_enabled: true
    });
    return this.registerAndStartAccount(idx, label);
  }

  async resetAccount(accountIndex) {
    const instance = this.getAccount(accountIndex);
    if (!instance) {
      throw new Error(`Account ${accountIndex} not found in active cluster.`);
    }
    await instance.resetSession();
    return { ok: true, message: `Account ${accountIndex} session reset successfully.` };
  }

  /**
   * LRU (Least Recently Used) SIM Selection for Fast Lane
   * Fast Lane bypasses 25/day reminder limit completely!
   */
  async selectFastLaneAccount() {
    const readyAccounts = [];

    for (const [idx, inst] of this.accounts.entries()) {
      if (inst.isReady()) {
        const dbAcc = await db.getAccountByIndex(idx);
        readyAccounts.push({
          instance: inst,
          dbRecord: dbAcc,
          lastSentAt: dbAcc?.last_sent_at ? new Date(dbAcc.last_sent_at).getTime() : 0
        });
      }
    }

    if (readyAccounts.length === 0) return null;

    // Pick Least Recently Used (oldest last_sent_at)
    readyAccounts.sort((a, b) => a.lastSentAt - b.lastSentAt);
    return readyAccounts[0].instance;
  }

  /**
   * LRU Selection for Slow Lane (Reminders & Marketing)
   * Strictly enforces:
   * 1. Max 25 reminders/day/SIM
   * 2. Batch pause (10 min after every 5 reminders)
   * 3. LRU distribution across all remaining eligible SIMs
   */
  async selectSlowLaneAccount() {
    const now = Date.now();
    const eligibleAccounts = [];

    for (const [idx, inst] of this.accounts.entries()) {
      if (!inst.isReady()) continue;

      const dbAcc = await db.getAccountByIndex(idx);
      if (!dbAcc) continue;

      // Rule 1: Check daily reminder cap
      const sentToday = dbAcc.sent_reminders_today || 0;
      const limit = dbAcc.daily_reminder_limit || config.engine.slowLane.dailyReminderLimit;
      if (sentToday >= limit) {
        // Daily cap hit! Skip this line for reminders (line still available for transactional!)
        continue;
      }

      // Rule 2: Check batch pause
      const pausedUntil = this.batchPauseMap.get(idx) || 0;
      if (now < pausedUntil) {
        // Line currently cooling down in batch pause
        continue;
      }

      eligibleAccounts.push({
        instance: inst,
        dbRecord: dbAcc,
        lastReminderSentAt: dbAcc.last_reminder_sent_at ? new Date(dbAcc.last_reminder_sent_at).getTime() : 0
      });
    }

    if (eligibleAccounts.length === 0) return null;

    // Pick Least Recently Used reminder line
    eligibleAccounts.sort((a, b) => a.lastReminderSentAt - b.lastReminderSentAt);
    return eligibleAccounts[0];
  }

  /**
   * Starts Dual-Lane Scheduling Engine
   */
  startDualLaneEngines() {
    this.isFastLaneRunning = true;
    this.isSlowLaneRunning = true;

    console.log('[Dual-Lane Engine] Starting Fast Lane & Slow Lane schedulers...');
    this.processFastLaneLoop();
    this.processSlowLaneLoop();
  }

  /**
   * Fast Lane: Immediate dispatch for receipts, welcome, OTP, tests
   * High priority, never blocked by slow lane pauses
   */
  async processFastLaneLoop() {
    if (!this.isFastLaneRunning) return;

    try {
      const msg = await db.fetchNextPendingFastLane();
      if (msg) {
        const account = await this.selectFastLaneAccount();
        if (account) {
          // Lock message as processing
          await db.updateMessageStatus(msg.id, 'processing', {
            assignedAccountIndex: account.accountIndex
          });

          // Organic pacing jitter (3 to 10 seconds)
          const delayMs = Math.floor(
            Math.random() * (config.engine.fastLane.maxDelayMs - config.engine.fastLane.minDelayMs + 1)
          ) + config.engine.fastLane.minDelayMs;

          await new Promise(r => setTimeout(r, delayMs));

          try {
            const sendRes = await account.sendMessage({
              to: msg.to_phone,
              text: msg.message,
              pdfBase64: msg.pdf_base64,
              pdfFileName: msg.pdf_file_name,
              kind: msg.kind
            });

            await db.updateMessageStatus(msg.id, 'sent', {
              sentByPhone: account.phoneNumber,
              sentAt: new Date().toISOString()
            });

            console.log(`[Fast Lane] Sent message ${msg.id} to ${msg.to_phone} via Line ${account.accountIndex}`);
          } catch (sendErr) {
            console.error(`[Fast Lane] Failed sending ${msg.id}:`, sendErr.message);
            await db.updateMessageStatus(msg.id, 'failed', {
              errorMessage: sendErr.message
            });
          }
        }
      }
    } catch (loopErr) {
      console.error('[Fast Lane Loop Error]:', loopErr.message);
    }

    // Fast lane checks every 1.5s for instant pickup
    this.fastLaneTimeout = setTimeout(() => this.processFastLaneLoop(), 1500);
  }

  /**
   * Slow Lane: Paced dispatch for reminders and marketing
   * 10 - 16 minutes pacing between messages
   * Max 25 messages per SIM per day
   * 10 minutes batch pause every 5 consecutive messages
   */
  async processSlowLaneLoop() {
    if (!this.isSlowLaneRunning) return;

    let nextIntervalMs = config.engine.slowLane.minIntervalMs;

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
            console.log(`[Slow Lane] Processing reminder ${msg.id} via Line ${accountIndex}...`);
            await instance.sendMessage({
              to: msg.to_phone,
              text: msg.message,
              kind: msg.kind
            });

            await db.updateMessageStatus(msg.id, 'sent', {
              sentByPhone: instance.phoneNumber,
              sentAt: new Date().toISOString()
            });

            console.log(`[Slow Lane] Successfully delivered reminder ${msg.id}`);

            // Rule 3: Check consecutive count for 10-minute batch pause
            const newConsecutive = (dbRecord.consecutive_reminders_count || 0) + 1;
            if (newConsecutive >= config.engine.slowLane.batchPauseThreshold) {
              const pauseUntil = Date.now() + config.engine.slowLane.batchPauseDurationMs;
              this.batchPauseMap.set(accountIndex, pauseUntil);
              await db.resetConsecutiveReminders(accountIndex);
              console.log(`[Slow Lane] Line ${accountIndex} hit 5 consecutive reminders. Cooling down in 10-minute pause.`);
            }

            // Calculate next pacing delay: 10 to 16 minutes
            const jitter = Math.floor(Math.random() * config.engine.slowLane.maxJitterMs);
            nextIntervalMs = config.engine.slowLane.minIntervalMs + jitter;
            console.log(`[Slow Lane] Next reminder scheduled in ${Math.round(nextIntervalMs / 60000)} minutes.`);
          } catch (sendErr) {
            console.error(`[Slow Lane] Failed sending reminder ${msg.id}:`, sendErr.message);
            await db.updateMessageStatus(msg.id, 'failed', {
              errorMessage: sendErr.message
            });
            nextIntervalMs = 15000; // Retry next pending in 15s
          }
        } else {
          // No SIM ready or all reached daily cap / in batch pause
          nextIntervalMs = 30000; // Check again in 30s
        }
      } else {
        // No slow lane messages in outbox
        nextIntervalMs = 5000;
      }
    } catch (err) {
      console.error('[Slow Lane Loop Error]:', err.message);
      nextIntervalMs = 10000;
    }

    this.slowLaneTimeout = setTimeout(() => this.processSlowLaneLoop(), nextIntervalMs);
  }

  stop() {
    this.isFastLaneRunning = false;
    this.isSlowLaneRunning = false;
    if (this.fastLaneTimeout) clearTimeout(this.fastLaneTimeout);
    if (this.slowLaneTimeout) clearTimeout(this.slowLaneTimeout);
  }
}

export const clusterManager = new ClusterManager();
