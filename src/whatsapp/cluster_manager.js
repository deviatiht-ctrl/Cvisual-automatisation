import crypto from 'crypto';
import path from 'path';
import { WhatsAppAccountInstance, normalizePhoneDigits } from './account_instance.js';
import { sessionStore } from './session_store.js';
import { db } from '../database.js';
import { config } from '../config.js';

export function signWebhookPayload(secret, timestamp, rawBody) {
  return crypto
    .createHmac('sha256', String(secret))
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
}

export async function deliverWebhook(webhook, eventName, data = {}, timeoutMs = 8000) {
  if (!webhook?.url) {
    return { ok: false, status: 0, error: 'Missing webhook URL' };
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const payload = {
    id: 'evt_' + crypto.randomBytes(12).toString('hex'),
    event: eventName,
    timestamp: new Date().toISOString(),
    data
  };
  const rawBody = JSON.stringify(payload);

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'CVISUAL-WhatsApp-Webhook/1.0',
    'X-CVISUAL-Event': eventName,
    'X-CVISUAL-Timestamp': timestamp
  };

  if (webhook.secret) {
    headers['X-CVISUAL-Signature'] = `sha256=${signWebhookPayload(webhook.secret, timestamp, rawBody)}`;
  }

  try {
    const res = await fetch(webhook.url, {
      method: 'POST',
      headers,
      body: rawBody,
      signal: AbortSignal.timeout(timeoutMs)
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, status: 0, error: err?.message || String(err) };
  }
}

export class ClusterManager {
  constructor() {
    this.accounts = new Map(); // accountIndex -> WhatsAppAccountInstance
    this.isFastLaneRunning = false;
    this.isSlowLaneRunning = false;
    this.fastLaneTimeout = null;
    this.slowLaneTimeout = null;
  }

  async dispatchWebhooks(tenantId, eventName, data) {
    if (!tenantId) return;
    try {
      const webhooks = await db.listWebhooks(tenantId);
      if (!Array.isArray(webhooks) || webhooks.length === 0) return;

      for (const wh of webhooks) {
        const subscribed = Array.isArray(wh.events) && wh.events.length > 0 ? wh.events : ['*'];
        if (subscribed.includes('*') || subscribed.includes(eventName)) {
          deliverWebhook(wh, eventName, data).catch(err => {
            console.warn(`[Webhook] Delivery failed to ${wh.url}:`, err?.message || err);
          });
        }
      }
    } catch (err) {
      console.warn('[Webhook Dispatch Warning]:', err?.message || err);
    }
  }

  async initializeCluster() {
    console.log(
      `[Cluster Manager] Initializing Native WhatsApp Cluster (maxConcurrentAccounts=${config.maxConcurrentAccounts})...`
    );

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

    const primaryIdx = config.securgym?.accountIndex || 1;
    const primary = enabled.find(a => a.account_index === primaryIdx) || enabled[0] || {
      account_index: primaryIdx,
      label: `Liy Prensipal ${primaryIdx}`
    };

    const backedUpIndices = await sessionStore.listBackedUpIndices().catch(() => new Set());

    // Start all enabled accounts up to maxConcurrentAccounts (including DALIGHT dedicated lines)
    const toStart = [];
    if (primary && !enabled.some(a => a.account_index === primary.account_index)) {
      toStart.push(primary);
    }
    for (const acc of enabled) {
      if (toStart.length >= config.maxConcurrentAccounts) break;
      if (!toStart.some(a => a.account_index === acc.account_index)) {
        toStart.push(acc);
      }
    }

    const registered = [];
    for (const acc of toStart) {
      const idx = parseInt(acc.account_index, 10);
      if (!this.accounts.has(idx) && this.accounts.size < config.maxConcurrentAccounts) {
        const inst = new WhatsAppAccountInstance(idx, acc.label || `Liy ${idx}`, {
          tenantId: acc.tenant_id || null,
          tenantName: acc.tenant_name || null
        });
        inst.tenantId = acc.tenant_id || null;
        inst.tenantName = acc.tenant_name || null;
        this.accounts.set(idx, inst);
        registered.push(inst);
      }
    }

    // Start sockets right after HTTP server binds /health
    setTimeout(() => {
      for (const instance of registered) {
        instance.initialize().catch(err => {
          console.error(`[Cluster Manager] Error during initialization of Account ${instance.accountIndex}:`, err.message);
        });
      }
    }, 600);

    // Start CVISUAL multi-tenant dual-lane background processors
    this.startDualLaneEngines();
  }

  async registerAndStartAccount(accountIndex, label, { userTriggered = true } = {}) {
    const idx = parseInt(accountIndex, 10);
    if (this.accounts.has(idx)) {
      const existing = this.accounts.get(idx);
      if (userTriggered && !existing.isReady() && !existing.isInitializing && existing.status !== 'SCAN_QR') {
        existing.initialize({ userTriggered: true }).catch(() => {});
      }
      return existing;
    }

    if (this.accounts.size >= config.maxConcurrentAccounts) {
      console.warn(
        `[Cluster Manager] Blocked spawning Account ${idx}: maxConcurrentAccounts (${config.maxConcurrentAccounts}) limit active.`
      );
      return null;
    }

    const dbAcc = await db.getAccountByIndex(idx).catch(() => null);
    const instance = new WhatsAppAccountInstance(idx, label || dbAcc?.label || `Liy ${idx}`, {
      tenantId: dbAcc?.tenant_id || null,
      tenantName: dbAcc?.tenant_name || null
    });
    instance.tenantId = dbAcc?.tenant_id || null;
    instance.tenantName = dbAcc?.tenant_name || null;
    this.accounts.set(idx, instance);

    instance.initialize({ userTriggered }).catch(err => {
      console.error(`[Cluster Manager] Error during initialization of Account ${idx}:`, err.message);
    });

    return instance;
  }

  getAccount(accountIndex) {
    const idx = parseInt(accountIndex, 10);
    return this.accounts.get(idx) || null;
  }

  getAllAccounts() {
    return Array.from(this.accounts.values()).sort((a, b) => a.accountIndex - b.accountIndex);
  }

  getPrimaryReadyAccount(excludeIndices = [], allowedIndices = []) {
    const excludeSet = new Set((excludeIndices || []).map(i => parseInt(i, 10)));
    const allowedSet = (allowedIndices && allowedIndices.length > 0)
      ? new Set(allowedIndices.map(i => parseInt(i, 10)))
      : null;

    const ready = this.getAllAccounts().filter(a => {
      if (!a.isReady()) return false;
      if (allowedSet && !allowedSet.has(a.accountIndex)) return false;
      if (excludeSet.has(a.accountIndex)) return false;
      // 🛡️ CRITICAL: If no explicit allowedSet was passed, NEVER allow dedicated tenant lines or Line 3 into the shared pool!
      if (!allowedSet && (a.tenantId || a.accountIndex === 3)) return false;
      return true;
    });
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
      instance = await this.registerAndStartAccount(idx, `SIM Liy ${idx}`, { userTriggered: true });
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
    let instance = this.getAccount(idx);
    if (!instance && this.accounts.size < config.maxConcurrentAccounts) {
      await sessionStore.remove(idx).catch(() => {});
      instance = await this.registerAndStartAccount(idx, `SIM Liy ${idx}`, { userTriggered: true });
      return { ok: true, message: `Account ${idx} session reset and initializing.` };
    }
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
   * Direct immediate dispatch for Fast Lane HTTP endpoints (/api/send, /api/test, /api/v1/messages/send mode=sync)
   */
  async sendMessageAnywhere({
    to,
    message,
    pdfBase64 = null,
    pdfFileName = null,
    kind = 'test',
    preferredAccountIndex = null,
    allowedIndices = [],
    excludeIndices = []
  }) {
    const cleanPhone = normalizePhoneDigits(to, config.securgym?.defaultCountryCode || '509');
    if (!cleanPhone || cleanPhone.length < 8) {
      throw new Error('Numéro destinataire invalide (minimum 8 chiffres).');
    }

    const allowedSet = (allowedIndices && allowedIndices.length > 0)
      ? new Set(allowedIndices.map(i => parseInt(i, 10)))
      : null;
    const excludeSet = new Set((excludeIndices || []).map(i => parseInt(i, 10)));

    const prefIdx = preferredAccountIndex ? parseInt(preferredAccountIndex, 10) : null;
    if (prefIdx !== null) {
      if (allowedSet && !allowedSet.has(prefIdx)) {
        throw new Error(`Liy WhatsApp #${prefIdx} pa nan lis liy dedye antrepriz ou a (Liy pèmèt: ${Array.from(allowedSet).join(', ')}).`);
      }
      if (excludeSet.has(prefIdx)) {
        throw new Error(`Liy WhatsApp #${prefIdx} rezève eksklizivman pou yon lòt antrepriz.`);
      }
      const target = this.getAccount(prefIdx);
      if (!target || !target.isReady()) {
        throw new Error(`Liy WhatsApp #${prefIdx} pa konekte oswa pa prè pou kounye a.`);
      }
    }

    let chosen = null;
    for (let attempt = 0; attempt < 16; attempt++) {
      if (prefIdx !== null) {
        const target = this.getAccount(prefIdx);
        if (target && target.isReady() && !target.isBusy) {
          chosen = target;
          break;
        }
        if (!target || !target.isReady()) break;
      } else {
        const readyAccounts = this.getAllAccounts().filter(a => {
          if (!a.isReady() || a.isBusy) return false;
          if (allowedSet && !allowedSet.has(a.accountIndex)) return false;
          if (excludeSet.has(a.accountIndex)) return false;
          return true;
        });
        if (readyAccounts.length > 0) {
          readyAccounts.sort((a, b) => (a.lastSentAt || 0) - (b.lastSentAt || 0));
          chosen = readyAccounts[0];
          break;
        }
        const anyReady = this.getAllAccounts().some(a => {
          if (!a.isReady()) return false;
          if (allowedSet && !allowedSet.has(a.accountIndex)) return false;
          if (excludeSet.has(a.accountIndex)) return false;
          return true;
        });
        if (!anyReady) break;
      }
      await new Promise(r => setTimeout(r, 500));
    }

    if (!chosen) {
      if (allowedSet && allowedSet.size > 0) {
        throw new Error(`Liy dedye antrepriz ou a (${Array.from(allowedSet).map(i => '#' + i).join(', ')}) pa pare oswa pa konekte pou voye mesaj kounye a.`);
      }
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

  async selectFastLaneAccount(preferredAccountIndex = null, allowedIndices = [], excludeIndices = []) {
    const prefIdx = preferredAccountIndex ? parseInt(preferredAccountIndex, 10) : null;
    const allowedSet = (allowedIndices && allowedIndices.length > 0)
      ? new Set(allowedIndices.map(i => parseInt(i, 10)))
      : null;
    const excludeSet = new Set((excludeIndices || []).map(i => parseInt(i, 10)));
    const readyAccounts = [];

    for (const [idx, inst] of this.accounts.entries()) {
      if (prefIdx !== null && idx !== prefIdx) continue;
      if (allowedSet && !allowedSet.has(idx)) continue;
      // 🛡️ CRITICAL: If no explicit allowedSet was passed, dedicated lines (Line 3 / tenant lines) CANNOT take shared messages!
      if (!allowedSet && (inst.tenantId || inst.accountIndex === 3)) continue;
      if (excludeSet.has(idx)) continue;
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

  async selectSlowLaneAccount(preferredAccountIndex = null, allowedIndices = [], excludeIndices = []) {
    const prefIdx = preferredAccountIndex ? parseInt(preferredAccountIndex, 10) : null;
    const allowedSet = (allowedIndices && allowedIndices.length > 0)
      ? new Set(allowedIndices.map(i => parseInt(i, 10)))
      : null;
    const excludeSet = new Set((excludeIndices || []).map(i => parseInt(i, 10)));
    const now = Date.now();
    const eligibleAccounts = [];

    for (const [idx, inst] of this.accounts.entries()) {
      if (prefIdx !== null && idx !== prefIdx) continue;
      if (allowedSet && !allowedSet.has(idx)) continue;
      // 🛡️ CRITICAL: If no explicit allowedSet was passed, dedicated lines (Line 3 / tenant lines) CANNOT take shared messages!
      if (!allowedSet && (inst.tenantId || inst.accountIndex === 3)) continue;
      if (excludeSet.has(idx)) continue;
      if (!inst.isReady() || inst.isBusy) continue;

      const dbAcc = await db.getAccountByIndex(idx);
      const sentToday = Math.max(dbAcc?.sent_reminders_today || 0, inst.sentRemindersToday || 0);
      const limit = Math.min(dbAcc?.daily_reminder_limit || config.engine.slowLane.dailyReminderLimit || 25, 25);
      if (sentToday >= limit) {
        continue;
      }

      if (inst.isSlowLaneCooldownActive(now)) {
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
        let allowed = [];
        let excluded = [];
        if (msg.tenant_id) {
          const tenant = await db.getTenantById(msg.tenant_id);
          if (tenant?.dedicated_account_indices && tenant.dedicated_account_indices.length > 0) {
            allowed = tenant.dedicated_account_indices;
          } else {
            excluded = await db.getAllDedicatedAccountIndices();
          }
        } else {
          excluded = await db.getAllDedicatedAccountIndices();
        }

        const account = await this.selectFastLaneAccount(msg.assigned_account_index || null, allowed, excluded);
        if (account) {
          await db.updateMessageStatus(msg.id, 'processing', {
            assignedAccountIndex: account.accountIndex
          });

          const delayMs =
            Math.floor(Math.random() * (config.engine.fastLane.maxDelayMs - config.engine.fastLane.minDelayMs + 1)) +
            config.engine.fastLane.minDelayMs;

          await new Promise(r => setTimeout(r, delayMs));

          try {
            const sendResult = await account.sendMessage({
              to: msg.to_phone,
              text: msg.message,
              pdfBase64: msg.pdf_base64,
              pdfFileName: msg.pdf_file_name,
              kind: msg.kind
            });

            const sentAt = new Date().toISOString();
            await db.updateMessageStatus(msg.id, 'sent', {
              assignedAccountIndex: account.accountIndex,
              sentByPhone: account.phoneNumber,
              sentAt,
              errorMessage: null
            });

            console.log(`[Fast Lane] Sent message ${msg.id} to ${msg.to_phone} via Line ${account.accountIndex}`);
            await this.dispatchWebhooks(msg.tenant_id, 'message.sent', {
              message_id: msg.id,
              tenant_id: msg.tenant_id,
              to_phone: msg.to_phone,
              kind: msg.kind,
              lane: 'fast_lane',
              account_index: account.accountIndex,
              sent_by_phone: account.phoneNumber || null,
              whatsapp_message_id: sendResult?.whatsappMessageId || null,
              sent_at: sentAt
            });
          } catch (sendErr) {
            const errMsg = sendErr?.message || String(sendErr);
            console.error(`[Fast Lane] Failed sending ${msg.id}:`, errMsg);
            const isPermanent =
              errMsg.includes('pa anrejistre sou WhatsApp') || errMsg.includes('pa valid');
            const outcome = await db.incrementMessageRetryOrFail(msg.id, errMsg, 5, isPermanent);
            if (outcome?.status === 'failed') {
              await this.dispatchWebhooks(msg.tenant_id, 'message.failed', {
                message_id: msg.id,
                tenant_id: msg.tenant_id,
                to_phone: msg.to_phone,
                kind: msg.kind,
                lane: 'fast_lane',
                retry_count: outcome.retryCount,
                error_message: errMsg
              });
            }
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
        let allowed = [];
        let excluded = [];
        if (msg.tenant_id) {
          const tenant = await db.getTenantById(msg.tenant_id);
          if (tenant?.dedicated_account_indices && tenant.dedicated_account_indices.length > 0) {
            allowed = tenant.dedicated_account_indices;
          } else {
            excluded = await db.getAllDedicatedAccountIndices();
          }
        } else {
          excluded = await db.getAllDedicatedAccountIndices();
        }

        const eligible = await this.selectSlowLaneAccount(msg.assigned_account_index || null, allowed, excluded);
        if (eligible) {
          const { instance } = eligible;
          const accountIndex = instance.accountIndex;

          await db.updateMessageStatus(msg.id, 'processing', {
            assignedAccountIndex: accountIndex
          });

          try {
            console.log(`[Slow Lane] Processing message ${msg.id} (${msg.kind}) via Line ${accountIndex}...`);
            const sendResult = await instance.sendMessage({
              to: msg.to_phone,
              text: msg.message,
              pdfBase64: msg.pdf_base64,
              pdfFileName: msg.pdf_file_name,
              kind: msg.kind
            });

            const sentAt = new Date().toISOString();
            await db.updateMessageStatus(msg.id, 'sent', {
              assignedAccountIndex: accountIndex,
              sentByPhone: instance.phoneNumber,
              sentAt,
              errorMessage: null
            });

            const pacing = instance.recordSlowLaneSendOutcome();
            if (pacing.batchPauseTriggered) {
              console.log(`[Slow Lane] Line ${accountIndex} hit batch pause threshold. Cooling down.`);
            }

            nextIntervalMs = Math.max(15000, pacing.gapMs);
            console.log(`[Slow Lane] Next message allowed in ${Math.round(pacing.gapMs / 60000)} minutes.`);

            await this.dispatchWebhooks(msg.tenant_id, 'message.sent', {
              message_id: msg.id,
              tenant_id: msg.tenant_id,
              to_phone: msg.to_phone,
              kind: msg.kind,
              lane: 'slow_lane',
              account_index: accountIndex,
              sent_by_phone: instance.phoneNumber || null,
              whatsapp_message_id: sendResult?.whatsappMessageId || null,
              sent_at: sentAt
            });
          } catch (sendErr) {
            const errMsg = sendErr?.message || String(sendErr);
            console.error(`[Slow Lane] Failed sending ${msg.id}:`, errMsg);
            const isPermanent =
              errMsg.includes('pa anrejistre sou WhatsApp') || errMsg.includes('pa valid');
            const outcome = await db.incrementMessageRetryOrFail(msg.id, errMsg, 5, isPermanent);
            if (outcome?.status === 'failed') {
              await this.dispatchWebhooks(msg.tenant_id, 'message.failed', {
                message_id: msg.id,
                tenant_id: msg.tenant_id,
                to_phone: msg.to_phone,
                kind: msg.kind,
                lane: 'slow_lane',
                retry_count: outcome.retryCount,
                error_message: errMsg
              });
            }
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
