import { config } from '../config.js';
import { db } from '../database.js';
import { clusterManager } from '../whatsapp/cluster_manager.js';
import { normalizePhoneDigits } from '../whatsapp/account_instance.js';

const FAST_LANE_KINDS = new Set(['receipt', 'welcome', 'otp', 'test', 'manual_direct']);
const FORBIDDEN_PATTERN =
  /Abonnement Expir[ée]|Dernier Jour|Ab[òo]nman Ekspire|D[èe]nye Jou|Membership Expired|Final Day/i;
const WELCOME_TEXT_PATTERN =
  /(?:Bienvenue (?:à|chez)|Welcome to|Byenvini nan)[\s\S]*(?:N[°o]\s*Membre|Member ID|N[°o]\s*Manm|espace membre|Espas Manm)/i;
const RECEIPT_TEXT_PATTERN = /Re[çc]u de Paiement|Payment Receipt|Resi Peman/i;

function isFastLaneKind(kind) {
  return FAST_LANE_KINDS.has(String(kind || '').toLowerCase().trim());
}

function getTodayUtcStartIso() {
  return new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';
}

function buildPhoneVariants(digits) {
  const clean = String(digits || '').replace(/\D/g, '');
  const variants = new Set();
  if (clean) variants.add(clean);
  const cc = (config.securgym?.defaultCountryCode || '509').replace(/\D/g, '') || '509';
  if (clean.startsWith(cc) && clean.length === cc.length + 8) {
    variants.add(clean.slice(cc.length));
  } else if (clean.length === 8 && cc) {
    variants.add(cc + clean);
  }
  return Array.from(variants);
}

class SecurGymBridgeWorker {
  constructor() {
    this.isRunning = false;
    this.heartbeatTimer = null;
    this.fastLaneTimer = null;
    this.slowLaneTimer = null;
    this.bridgeCmdTimer = null;
    this.recoveryTimer = null;
    this.cronTimer = null;

    this.isSyncingHeartbeat = false;
    this.isDispatchingFast = false;
    this.isDispatchingSlow = false;
    this.isProcessingCommands = false;

    // Pacing & safety state (hydrated from Supabase outbox on boot)
    this.dailyReminderCap = Math.min(config.engine.slowLane.dailyReminderLimit || 25, 25);
    this.sentRemindersToday = 0;
    this.sentFastToday = 0;
    this.consecutiveReminders = 0;
    this.lastReminderSentAt = 0;
    this.nextSlowLaneAllowedAt = 0;
    this.batchPauseUntil = 0;
    this.hydratedUtcDay = '';
    this.lastQueueLength = 0;
    this.remoteRestrictedUntil = null;
    this.lastBridgeError = null;
    this.lastSanitizeAt = 0;
  }

  isEnabled() {
    return Boolean(
      config.securgym?.enabled &&
        config.securgym?.supabaseUrl &&
        config.securgym?.supabaseKey
    );
  }

  getAccountIndex() {
    return config.securgym?.accountIndex || 1;
  }

  _headers(extra = {}) {
    const key = config.securgym.supabaseKey;
    return {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...extra
    };
  }

  async _rest(pathWithQuery, { method = 'GET', body = undefined, headers = {}, timeoutMs = 12000 } = {}) {
    const url = `${config.securgym.supabaseUrl}/rest/v1/${pathWithQuery}`;
    const res = await fetch(url, {
      method,
      headers: this._headers(headers),
      body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    });
    return res;
  }

  async _rpc(fnName, params = {}, timeoutMs = 12000) {
    return this._rest(`rpc/${fnName}`, {
      method: 'POST',
      body: params,
      timeoutMs
    });
  }

  /**
   * Hydrate today's UTC slow-lane & fast-lane counters directly from SecurGYM's
   * whatsapp_messages_outbox so container restarts NEVER reset daily anti-ban caps.
   */
  async hydrateDailyCounters() {
    if (!this.isEnabled()) return;
    try {
      const todayIso = getTodayUtcStartIso();
      const todayDay = todayIso.slice(0, 10);

      const res = await this._rest(
        `whatsapp_messages_outbox?status=eq.sent&sent_at=gte.${encodeURIComponent(todayIso)}&select=id,kind,sent_at&order=sent_at.desc&limit=500`
      );
      if (res.ok) {
        const rows = await res.json();
        let slowCount = 0;
        let fastCount = 0;
        let latestSlowAt = 0;

        for (const r of Array.isArray(rows) ? rows : []) {
          if (isFastLaneKind(r.kind)) {
            fastCount++;
          } else {
            slowCount++;
            const t = r.sent_at ? new Date(r.sent_at).getTime() : 0;
            if (t > latestSlowAt) latestSlowAt = t;
          }
        }

        this.hydratedUtcDay = todayDay;
        this.sentRemindersToday = slowCount;
        this.sentFastToday = fastCount;
        this.lastReminderSentAt = latestSlowAt;

        if (latestSlowAt > 0) {
          const minGap = config.engine.slowLane.minIntervalMs || 600000;
          const jitter = Math.floor(Math.random() * Math.min(config.engine.slowLane.maxJitterMs || 360000, 180000));
          const candidateNext = latestSlowAt + minGap + jitter;
          if (candidateNext > this.nextSlowLaneAllowedAt) {
            this.nextSlowLaneAllowedAt = candidateNext;
          }
        }

        // Sync counters onto live AccountInstance
        const acc = clusterManager.getAccount(this.getAccountIndex());
        if (acc) {
          acc.sentRemindersToday = slowCount;
          acc.sentTransactionalToday = fastCount;
          acc.sentToday = slowCount + fastCount;
          if (latestSlowAt > (acc.lastReminderSentAt || 0)) {
            acc.lastReminderSentAt = latestSlowAt;
          }
        }

        console.log(
          `[SecurGYM Bridge] 📊 Hydrated today's (${todayDay}) counters: SlowLane=${slowCount}/${this.dailyReminderCap}, FastLane=${fastCount}`
        );
      }

      // Sync daily cap & restriction from platform_whatsapp_accounts
      const accRes = await this._rest(
        `platform_whatsapp_accounts?account_index=eq.${this.getAccountIndex()}&select=daily_limit,restricted_until,service_status`
      );
      if (accRes.ok) {
        const list = await accRes.json();
        const row = Array.isArray(list) ? list[0] : null;
        if (row) {
          const remoteCap = Number(row.daily_limit);
          const hardAntiBanCap = Math.min(config.engine.slowLane.dailyReminderLimit || 25, 25);
          this.dailyReminderCap =
            Number.isFinite(remoteCap) && remoteCap > 0
              ? Math.min(remoteCap, hardAntiBanCap)
              : hardAntiBanCap;

          if (row.service_status === 'RESTRICTED' && row.restricted_until) {
            this.remoteRestrictedUntil = row.restricted_until;
          }
        }
      }
    } catch (err) {
      console.warn('[SecurGYM Bridge] hydrateDailyCounters warning:', err.message);
    }
  }

  _rolloverUtcDayIfNeeded() {
    const todayDay = new Date().toISOString().slice(0, 10);
    if (this.hydratedUtcDay && this.hydratedUtcDay !== todayDay) {
      this.hydratedUtcDay = todayDay;
      this.sentRemindersToday = 0;
      this.sentFastToday = 0;
      this.consecutiveReminders = 0;
      this.batchPauseUntil = 0;
      const acc = clusterManager.getAccount(this.getAccountIndex());
      if (acc) {
        acc.sentRemindersToday = 0;
        acc.sentTransactionalToday = 0;
        acc.sentToday = 0;
        acc.consecutiveRemindersCount = 0;
      }
      console.log(`[SecurGYM Bridge] 🌅 Nouveau jour UTC (${todayDay}) — compteurs réinitialisés.`);
    }
  }

  attachAccountListeners(acc) {
    if (!acc || acc._securgymBridgeHooked) return;
    acc._securgymBridgeHooked = true;
    const pushSoon = () => {
      setTimeout(() => this.syncAndHeartbeat(), 250);
    };
    acc.on('qr', pushSoon);
    acc.on('authenticated', pushSoon);
    acc.on('ready', pushSoon);
    acc.on('disconnected', pushSoon);
  }

  async start() {
    if (!this.isEnabled()) {
      console.log('[SecurGYM Bridge] Disabled (set SECURGYM_ENABLED=true + URL/KEY to activate).');
      return;
    }
    if (this.isRunning) return;
    this.isRunning = true;

    console.log(
      `[SecurGYM Bridge] 🚀 Connected to ${config.securgym.supabaseUrl} (Cloud Line ${this.getAccountIndex()}, Slow-Lane Cap=${this.dailyReminderCap}/day)`
    );

    await this.hydrateDailyCounters();
    await this.recoverStuckProcessingMessages();
    await this.sanitizePendingOutbox();

    // Hook instant status events from all active accounts into Supabase heartbeat
    for (const acc of clusterManager.getAllAccounts()) {
      this.attachAccountListeners(acc);
    }

    // Immediate first heartbeat & command/outbox polling
    setTimeout(() => this.syncAndHeartbeat(), 1000);
    this.heartbeatTimer = setInterval(() => this.syncAndHeartbeat(), 5000);
    this.bridgeCmdTimer = setInterval(() => this.processBridgeCommands(), 1500);
    this.recoveryTimer = setInterval(() => this.recoverStuckProcessingMessages(), 2 * 60 * 1000);
    this.cronTimer = setInterval(
      () => this.runCronExpirationReminders(),
      config.securgym.cronIntervalMs || 60 * 60 * 1000
    );

    this._scheduleFastLane(1800);
    this._scheduleSlowLane(4500);
  }

  stop() {
    this.isRunning = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.fastLaneTimer) clearTimeout(this.fastLaneTimer);
    if (this.slowLaneTimer) clearTimeout(this.slowLaneTimer);
    if (this.bridgeCmdTimer) clearInterval(this.bridgeCmdTimer);
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    if (this.cronTimer) clearInterval(this.cronTimer);
    this.heartbeatTimer = null;
    this.fastLaneTimer = null;
    this.slowLaneTimer = null;
    this.bridgeCmdTimer = null;
    this.recoveryTimer = null;
    this.cronTimer = null;
  }

  _scheduleFastLane(ms) {
    if (!this.isRunning) return;
    this.fastLaneTimer = setTimeout(() => this.processFastLaneTick(), ms);
  }

  _scheduleSlowLane(ms) {
    if (!this.isRunning) return;
    this.slowLaneTimer = setTimeout(() => this.processSlowLaneTick(), ms);
  }

  async _countPendingOutbox() {
    try {
      const res = await this._rest('whatsapp_messages_outbox?status=eq.pending&select=id&limit=1', {
        method: 'GET',
        headers: { Prefer: 'count=exact' }
      });
      const range = res.headers.get('content-range');
      if (range && range.includes('/')) {
        const total = parseInt(range.split('/')[1], 10);
        if (!Number.isNaN(total)) {
          this.lastQueueLength = total;
          return total;
        }
      }
    } catch {}
    return this.lastQueueLength;
  }

  /**
   * 1. Inspects remote account flags (`RESET_REQUESTED`, `RESTART_REQUESTED`, `RESTRICTED`) BEFORE writing heartbeat.
   * 2. Cleans up stale non-managed lines stuck in `INITIALIZING`/`SCAN_QR`/`READY` (>45s stale).
   * 3. Sends cloud heartbeats for all active managed lines + global platform config.
   */
  async syncAndHeartbeat() {
    if (!this.isEnabled() || this.isSyncingHeartbeat) return;
    this.isSyncingHeartbeat = true;

    try {
      const managedIdx = this.getAccountIndex();

      // 1. Poll platform_whatsapp_accounts FIRST so Web commands are never clobbered
      const listRes = await this._rest('platform_whatsapp_accounts?order=account_index.asc');
      if (listRes.ok) {
        const rows = await listRes.json();

        for (const row of Array.isArray(rows) ? rows : []) {
          const idx = row.account_index;
          const remoteStatus = String(row.service_status || '').toUpperCase();
          let acc = clusterManager.getAccount(idx);

          if (remoteStatus === 'RESET_REQUESTED') {
            console.log(`[SecurGYM Bridge] 🔄 RESET_REQUESTED reçu pour Liy ${idx}.`);
            if (!acc && clusterManager.accounts.size < config.maxConcurrentAccounts) {
              acc = await clusterManager.registerAndStartAccount(idx, row.label || `Liy ${idx}`, { userTriggered: true });
              this.attachAccountListeners(acc);
            }
            if (acc) await acc.resetSession({ awaitInit: false });
            continue;
          }

          if (remoteStatus === 'RESTART_REQUESTED') {
            console.log(`[SecurGYM Bridge] 🔄 RESTART_REQUESTED reçu pour Liy ${idx}.`);
            if (!acc && clusterManager.accounts.size < config.maxConcurrentAccounts) {
              acc = await clusterManager.registerAndStartAccount(idx, row.label || `Liy ${idx}`, { userTriggered: true });
              this.attachAccountListeners(acc);
            } else if (acc) {
              await acc.restart({ awaitInit: false });
            }
            continue;
          }

          if (acc) {
            if (
              remoteStatus === 'RESTRICTED' &&
              row.restricted_until &&
              new Date(row.restricted_until).getTime() > Date.now()
            ) {
              if (acc.status !== 'RESTRICTED') {
                acc.status = 'RESTRICTED';
                acc.restrictedUntil = row.restricted_until;
                acc.restrictionReason = row.restriction_reason || 'Restriction enregistrée';
                await acc.destroyBrowserOnly();
              }
              if (idx === managedIdx) this.remoteRestrictedUntil = row.restricted_until;
            } else if (idx === managedIdx && remoteStatus !== 'RESTRICTED' && this.remoteRestrictedUntil) {
              this.remoteRestrictedUntil = null;
            }
          }
        }

        // Clean stale other lines that aren't spawned on this cloud worker
        const activeIndices = new Set(clusterManager.getAllAccounts().map(a => a.accountIndex));
        for (const r of Array.isArray(rows) ? rows : []) {
          if (activeIndices.has(r.account_index)) continue;
          const st = String(r.service_status || '').toUpperCase();
          const hbMs = r.last_heartbeat ? new Date(r.last_heartbeat).getTime() : 0;
          const isStale = !hbMs || Date.now() - hbMs > 45000;

          if (
            ['INITIALIZING', 'AUTHENTICATED', 'SCAN_QR'].includes(st) ||
            (st === 'READY' && isStale) ||
            r.qr_code ||
            (r.last_heartbeat && st === 'DISCONNECTED')
          ) {
            await this._rest(`platform_whatsapp_accounts?account_index=eq.${r.account_index}`, {
              method: 'PATCH',
              body: {
                service_status: 'DISCONNECTED',
                qr_code: null,
                last_error: null,
                last_heartbeat: null
              }
            }).catch(() => {});
          }
        }
      }

      const activeAccounts = clusterManager.getAllAccounts();
      if (activeAccounts.length === 0) return;

      for (const acc of activeAccounts) {
        this.attachAccountListeners(acc);
        const status = acc.status || 'DISCONNECTED';
        const qrPayload = status === 'SCAN_QR' ? (acc.qrCodeDataUrl || acc.rawQrCode || null) : null;
        const phoneVal = acc.phoneNumber || (['SCAN_QR', 'DISCONNECTED', 'ERROR'].includes(status) ? '' : null);
        const pushVal = acc.pushName || (['SCAN_QR', 'DISCONNECTED', 'ERROR'].includes(status) ? '' : null);

        await this._rpc('platform_whatsapp_account_heartbeat', {
          p_account_index: acc.accountIndex,
          p_service_status: status,
          p_phone_number: phoneVal,
          p_push_name: pushVal,
          p_qr_code: qrPayload,
          p_last_error: status === 'READY' ? null : (acc.lastError || null)
        });
      }

      const queueLength = await this._countPendingOutbox();
      const readyRep = activeAccounts.find(a => a.isReady());
      const primaryAcc = readyRep || clusterManager.getAccount(managedIdx) || activeAccounts[0];
      const globalStatus = readyRep ? 'READY' : (primaryAcc?.status || 'DISCONNECTED');
      const globalQr = globalStatus === 'SCAN_QR' ? (primaryAcc?.qrCodeDataUrl || primaryAcc?.rawQrCode || null) : null;

      await this._rpc('platform_whatsapp_heartbeat', {
        p_service_status: globalStatus,
        p_connected_phone: primaryAcc?.phoneNumber || null,
        p_push_name: primaryAcc?.pushName || null,
        p_qr_code: globalQr,
        p_queue_length: queueLength,
        p_last_error: globalStatus === 'READY' ? null : (primaryAcc?.lastError || null)
      });
    } catch (err) {
      this.lastBridgeError = err.message;
      console.warn('[SecurGYM Bridge] Heartbeat error:', err.message);
    } finally {
      this.isSyncingHeartbeat = false;
    }
  }

  /**
   * Blocks forbidden J-0 / Expired reminders, promotes misclassified Welcome / Receipt
   * messages queued as `manual` by older desktop clients, and drops stale (>36h) reminders.
   */
  async sanitizePendingOutbox(limit = 40) {
    if (!this.isEnabled()) return;
    try {
      const res = await this._rest(
        `whatsapp_messages_outbox?status=eq.pending&order=created_at.asc&limit=${limit}`
      );
      if (!res.ok) return;
      const rows = await res.json();
      if (!Array.isArray(rows) || rows.length === 0) return;

      const now = Date.now();
      for (const row of rows) {
        const rawKind = String(row.kind || 'manual').toLowerCase().trim();
        const msg = String(row.message || '');
        const pdfName = String(row.pdf_file_name || '');

        // 1. Never block explicit admin 'test' or 'otp'
        if (rawKind !== 'test' && rawKind !== 'otp') {
          if (
            rawKind === 'reminder_0d' ||
            rawKind === 'reminder_expired' ||
            rawKind === 'reminder_due' ||
            FORBIDDEN_PATTERN.test(msg)
          ) {
            await this._cancelOutboxRow(row.id, 'Bloqué automatiquement par Anti-Ban (J-0 / Expiré désactivé)');
            continue;
          }
        }

        // 2. Reclassify misplaced `manual` Welcome / Receipt messages so they get Fast Lane
        if (rawKind === 'manual') {
          if (pdfName.startsWith('Recu_') || RECEIPT_TEXT_PATTERN.test(msg)) {
            await this._rest(`whatsapp_messages_outbox?id=eq.${row.id}`, {
              method: 'PATCH',
              body: { kind: 'receipt' }
            }).catch(() => {});
            continue;
          }
          if (WELCOME_TEXT_PATTERN.test(msg)) {
            await this._rest(`whatsapp_messages_outbox?id=eq.${row.id}`, {
              method: 'PATCH',
              body: { kind: 'welcome' }
            }).catch(() => {});
            continue;
          }
        }

        // 3. Drop stale slow-lane reminders (> 36h)
        if (!isFastLaneKind(rawKind) && row.created_at) {
          const ageMs = now - new Date(row.created_at).getTime();
          if (ageMs > 36 * 3600 * 1000) {
            await this._cancelOutboxRow(row.id, 'Rappel expiré (>36h) annulé pour protection Anti-Ban');
          }
        }
      }
    } catch (err) {
      console.warn('[SecurGYM Bridge] sanitizePendingOutbox warning:', err.message);
    }
  }

  async _cancelOutboxRow(id, reason) {
    await this._rest(`whatsapp_messages_outbox?id=eq.${id}`, {
      method: 'PATCH',
      body: {
        status: 'cancelled',
        error_message: reason,
        processed_at: null
      }
    }).catch(() => {});
  }

  async _failOutboxRow(id, reason) {
    await this._rest(`whatsapp_messages_outbox?id=eq.${id}`, {
      method: 'PATCH',
      body: {
        status: 'failed',
        error_message: reason,
        processed_at: null
      }
    }).catch(() => {});
  }

  async _isDuplicateAlreadySent(row, cleanPhone, effectiveKind) {
    try {
      const variants = buildPhoneVariants(cleanPhone);
      const phoneFilter = variants.map(v => encodeURIComponent(v)).join(',');

      if (effectiveKind === 'welcome') {
        const res = await this._rest(
          `whatsapp_messages_outbox?status=eq.sent&kind=eq.welcome&to_phone=in.(${phoneFilter})&id=neq.${row.id}&select=id&limit=1`
        );
        if (res.ok) {
          const hits = await res.json();
          if (Array.isArray(hits) && hits.length > 0) return 'Doublon bienvenue déjà envoyé';
        }
      } else if (['reminder_7d', 'reminder_2d', 'reminder'].includes(effectiveKind)) {
        const since6d = new Date(Date.now() - 6 * 24 * 3600 * 1000).toISOString();
        const res = await this._rest(
          `whatsapp_messages_outbox?status=eq.sent&kind=eq.${encodeURIComponent(effectiveKind)}&to_phone=in.(${phoneFilter})&sent_at=gte.${encodeURIComponent(since6d)}&id=neq.${row.id}&select=id&limit=1`
        );
        if (res.ok) {
          const hits = await res.json();
          if (Array.isArray(hits) && hits.length > 0) return `Doublon ${effectiveKind} (<6 jours) évité`;
        }
      } else if (effectiveKind === 'receipt' && row.pdf_file_name) {
        const since90s = new Date(Date.now() - 90 * 1000).toISOString();
        const res = await this._rest(
          `whatsapp_messages_outbox?status=eq.sent&kind=eq.receipt&pdf_file_name=eq.${encodeURIComponent(row.pdf_file_name)}&to_phone=in.(${phoneFilter})&sent_at=gte.${encodeURIComponent(since90s)}&id=neq.${row.id}&select=id&limit=1`
        );
        if (res.ok) {
          const hits = await res.json();
          if (Array.isArray(hits) && hits.length > 0) return 'Double envoi rapide du même reçu évité';
        }
      }
    } catch {}
    return null;
  }

  /**
   * Inspects and validates one claimed or candidate row before dispatch.
   * Returns { skip: true } if cancelled/failed, or { skip: false, cleanPhone, effectiveKind }.
   */
  async _validateAndDeduplicateRow(row) {
    const rawKind = String(row.kind || 'manual').toLowerCase().trim();
    const msg = String(row.message || '');
    const pdfName = String(row.pdf_file_name || '');

    if (
      rawKind !== 'test' &&
      rawKind !== 'otp' &&
      (rawKind === 'reminder_0d' || rawKind === 'reminder_expired' || rawKind === 'reminder_due' || FORBIDDEN_PATTERN.test(msg))
    ) {
      await this._cancelOutboxRow(row.id, 'Bloqué automatiquement par Anti-Ban (J-0 / Expiré désactivé)');
      return { skip: true };
    }

    let effectiveKind = rawKind;
    if (rawKind === 'manual') {
      if (pdfName.startsWith('Recu_') || RECEIPT_TEXT_PATTERN.test(msg)) {
        effectiveKind = 'receipt';
      } else if (WELCOME_TEXT_PATTERN.test(msg)) {
        effectiveKind = 'welcome';
      }
    }

    if (!isFastLaneKind(effectiveKind) && row.created_at) {
      const ageMs = Date.now() - new Date(row.created_at).getTime();
      if (ageMs > 36 * 3600 * 1000) {
        await this._cancelOutboxRow(row.id, 'Rappel expiré (>36h) annulé pour protection Anti-Ban');
        return { skip: true };
      }
    }

    const cleanPhone = normalizePhoneDigits(row.to_phone, config.securgym?.defaultCountryCode || '509');
    if (!cleanPhone || cleanPhone.length < 8) {
      await this._failOutboxRow(row.id, 'Numéro destinataire invalide (minimum 8 chiffres)');
      return { skip: true };
    }

    const dupReason = await this._isDuplicateAlreadySent(row, cleanPhone, effectiveKind);
    if (dupReason) {
      await this._cancelOutboxRow(row.id, dupReason);
      return { skip: true };
    }

    return { skip: false, cleanPhone, effectiveKind };
  }

  async _markProcessing(id, accountIndex) {
    await this._rest(`whatsapp_messages_outbox?id=eq.${id}`, {
      method: 'PATCH',
      body: {
        status: 'processing',
        assigned_account_index: accountIndex,
        processed_at: new Date().toISOString()
      }
    });
  }

  async _markSentAndRecord(row, acc, effectiveKind) {
    await this._rest(`whatsapp_messages_outbox?id=eq.${row.id}`, {
      method: 'PATCH',
      body: {
        kind: effectiveKind,
        status: 'sent',
        assigned_account_index: acc.accountIndex,
        sent_by_phone: acc.phoneNumber || null,
        sent_at: new Date().toISOString(),
        error_message: null
      }
    });

    await this._rpc('platform_whatsapp_account_record_send', {
      p_account_index: acc.accountIndex,
      p_message_id: row.id
    }).catch(() => {});
  }

  async _markRetryOrFail(row, acc, errMsg) {
    const lower = String(errMsg || '').toLowerCase();
    if (
      lower.includes('restreint') ||
      lower.includes('restricted') ||
      lower.includes('401') ||
      lower.includes('403') ||
      lower.includes('rate-overlimit')
    ) {
      this.remoteRestrictedUntil = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
      await this._rpc('platform_whatsapp_account_report_restricted', {
        p_account_index: acc.accountIndex,
        p_hours: 24,
        p_reason: errMsg
      }).catch(() => {});
    }

    const isUnregistered =
      lower.includes('pa anrejistre sou whatsapp') ||
      lower.includes('not registered') ||
      lower.includes('pas enregistré');
    const retries = isUnregistered
      ? 5
      : Math.max(Number(row.retry_count || 0), Number(row.attempts || 0)) + 1;
    const status = retries >= 5 ? 'failed' : 'pending';
    await this._rest(`whatsapp_messages_outbox?id=eq.${row.id}`, {
      method: 'PATCH',
      body: {
        status,
        retry_count: retries,
        attempts: retries,
        processed_at: null,
        error_message: isUnregistered
          ? errMsg
          : `Echwe sou Liy ${acc.accountIndex} (${errMsg}); ${
              retries >= 5 ? 'abandone apre 5 tantativ' : 'ap re-eseye otomatikman'
            }`
      }
    }).catch(() => {});
  }

  /**
   * FAST LANE: Welcome, Payment Receipt PDF, Test, OTP, Manual Direct.
   * Instant dispatch (2-5s organic gap). NEVER blocked by the 25/day Slow Lane limit.
   */
  async processFastLaneTick() {
    if (!this.isRunning) return;
    let nextMs = 2500;

    if (!this.isDispatchingFast) {
      this.isDispatchingFast = true;
      try {
        this._rolloverUtcDayIfNeeded();
        if (Date.now() - this.lastSanitizeAt >= 15000) {
          this.lastSanitizeAt = Date.now();
          await this.sanitizePendingOutbox(20);
        }

        const acc = clusterManager.getPrimaryReadyAccount();
        if (acc && !acc.isBusy) {
          const res = await this._rest(
            'whatsapp_messages_outbox?status=eq.pending&kind=in.(receipt,welcome,otp,test,manual_direct)&order=created_at.asc&limit=1'
          );
          if (res.ok) {
            const rows = await res.json();
            const row = Array.isArray(rows) ? rows[0] : null;
            if (row) {
              const check = await this._validateAndDeduplicateRow(row);
              if (!check.skip) {
                await this._markProcessing(row.id, acc.accountIndex);
                try {
                  const fastJitter = 1500 + Math.floor(Math.random() * 2500);
                  await new Promise(r => setTimeout(r, fastJitter));

                  await acc.sendMessage({
                    to: check.cleanPhone,
                    text: row.message,
                    pdfBase64: row.pdf_base64,
                    pdfFileName: row.pdf_file_name,
                    kind: check.effectiveKind
                  });

                  this.sentFastToday++;
                  await this._markSentAndRecord(row, acc, check.effectiveKind);
                  console.log(
                    `[SecurGYM Fast Lane] ⚡ Sent ${check.effectiveKind} ${row.id} -> +${check.cleanPhone} (Line ${acc.accountIndex})`
                  );
                  nextMs = 1500;
                } catch (sendErr) {
                  console.warn(`[SecurGYM Fast Lane] Failed ${row.id}:`, sendErr.message);
                  await this._markRetryOrFail(row, acc, sendErr.message);
                  nextMs = 5000;
                }
              } else {
                nextMs = 500;
              }
            }
          }
        }
      } catch (err) {
        console.warn('[SecurGYM Fast Lane] Loop warning:', err.message);
      } finally {
        this.isDispatchingFast = false;
      }
    }

    this._scheduleFastLane(nextMs);
  }

  /**
   * SLOW LANE: Renewal Reminders (J-7, J-2), Marketing Campaigns, Legacy Manual.
   * Strictly enforces 25/day cap, 10-16 min delay, 10-min pause every 5 consecutive, Spintax+Shield.
   */
  async processSlowLaneTick() {
    if (!this.isRunning) return;
    let nextMs = 10000;

    if (!this.isDispatchingSlow) {
      this.isDispatchingSlow = true;
      try {
        this._rolloverUtcDayIfNeeded();
        const now = Date.now();

        if (this.sentRemindersToday >= this.dailyReminderCap) {
          nextMs = 60000;
        } else if (now < this.batchPauseUntil || now < this.nextSlowLaneAllowedAt) {
          nextMs = 15000;
        } else {
          const acc = clusterManager.getPrimaryReadyAccount();
          if (acc && !acc.isBusy) {
            // Respect 15s quiet buffer after any recent Fast Lane send
            if (acc.lastSentAt && now - acc.lastSentAt < 15000) {
              nextMs = 15000 - (now - acc.lastSentAt) + 500;
            } else {
              const res = await this._rest(
                'whatsapp_messages_outbox?status=eq.pending&kind=not.in.(receipt,welcome,otp,test,manual_direct)&order=created_at.asc&limit=1'
              );
              if (res.ok) {
                const rows = await res.json();
                const row = Array.isArray(rows) ? rows[0] : null;
                if (row) {
                  const check = await this._validateAndDeduplicateRow(row);
                  if (!check.skip) {
                    if (isFastLaneKind(check.effectiveKind)) {
                      // Reclassified to Fast Lane — Fast Lane tick will send immediately
                      nextMs = 2000;
                    } else {
                      await this._markProcessing(row.id, acc.accountIndex);
                      try {
                        console.log(
                          `[SecurGYM Slow Lane] ⏳ Dispatching ${check.effectiveKind} ${row.id} -> +${check.cleanPhone} (${this.sentRemindersToday + 1}/${this.dailyReminderCap} today)...`
                        );
                        await acc.sendMessage({
                          to: check.cleanPhone,
                          text: row.message,
                          pdfBase64: row.pdf_base64,
                          pdfFileName: row.pdf_file_name,
                          kind: check.effectiveKind
                        });

                        this.sentRemindersToday++;
                        this.lastReminderSentAt = Date.now();
                        this.consecutiveReminders++;

                        await this._markSentAndRecord(row, acc, check.effectiveKind);

                        const minGap = config.engine.slowLane.minIntervalMs || 600000;
                        const maxJitter = config.engine.slowLane.maxJitterMs || 360000;
                        const gap = minGap + Math.floor(Math.random() * maxJitter);
                        this.nextSlowLaneAllowedAt = Date.now() + gap;

                        const batchThreshold = config.engine.slowLane.batchPauseThreshold || 5;
                        if (this.consecutiveReminders >= batchThreshold) {
                          const pauseMs = config.engine.slowLane.batchPauseDurationMs || 600000;
                          this.batchPauseUntil = Date.now() + pauseMs;
                          this.consecutiveReminders = 0;
                          console.log(
                            `[SecurGYM Slow Lane] 🛑 Batch pause (${Math.round(pauseMs / 60000)}m) after ${batchThreshold} consecutive reminders.`
                          );
                        } else {
                          console.log(
                            `[SecurGYM Slow Lane] ✅ Sent (${this.sentRemindersToday}/${this.dailyReminderCap}). Next slow-lane reminder in ${Math.round(gap / 60000)} min.`
                          );
                        }
                        nextMs = 15000;
                      } catch (sendErr) {
                        console.warn(`[SecurGYM Slow Lane] Failed ${row.id}:`, sendErr.message);
                        await this._markRetryOrFail(row, acc, sendErr.message);
                        nextMs = 20000;
                      }
                    }
                  } else {
                    nextMs = 1500;
                  }
                }
              }
            }
          }
        }
      } catch (err) {
        console.warn('[SecurGYM Slow Lane] Loop warning:', err.message);
      } finally {
        this.isDispatchingSlow = false;
      }
    }

    this._scheduleSlowLane(nextMs);
  }

  /**
   * Unsticks messages left in `processing` if a container crashed/restarted mid-send.
   */
  async recoverStuckProcessingMessages() {
    if (!this.isEnabled()) return;
    try {
      const cutoff = new Date(Date.now() - 3 * 60 * 1000).toISOString();
      await this._rest(
        `whatsapp_messages_outbox?status=eq.processing&processed_at=lt.${encodeURIComponent(cutoff)}`,
        {
          method: 'PATCH',
          body: { status: 'pending', processed_at: null }
        }
      );
    } catch {}
  }

  /**
   * Handles interactive WhatsApp Web chat commands triggered by the "Agrandir" dialog in SecurGYM Web.
   */
  async processBridgeCommands() {
    if (!this.isEnabled() || this.isProcessingCommands) return;
    this.isProcessingCommands = true;

    try {
      const res = await this._rest('whatsapp_bridge_commands?status=eq.pending&order=created_at.asc&limit=5');
      if (!res.ok) return;
      const rows = await res.json();
      if (!Array.isArray(rows) || rows.length === 0) return;

      for (const cmd of rows) {
        try {
          const acc = clusterManager.getAccount(cmd.account_index || this.getAccountIndex()) || clusterManager.getPrimaryReadyAccount();
          if (!acc || !acc.isReady()) {
            throw new Error(`Liy ${cmd.account_index || this.getAccountIndex()} pa konekte pou kounye a.`);
          }
          const payload = cmd.payload && typeof cmd.payload === 'object' ? cmd.payload : {};
          let result;
          if (cmd.action === 'list_chats') {
            result = { chats: await acc.listChats(payload.limit || 35) };
          } else if (cmd.action === 'get_messages') {
            result = { messages: await acc.getChatMessages(payload.chatId || '', payload.limit || 50) };
          } else if (cmd.action === 'send_chat') {
            result = { message: await acc.sendDirectChatMessage(payload.chatId || '', payload.message || '') };
          } else {
            throw new Error(`Aksyon enkoni: ${cmd.action}`);
          }

          await this._rest(`whatsapp_bridge_commands?id=eq.${cmd.id}`, {
            method: 'PATCH',
            body: {
              status: 'done',
              result,
              error_message: null,
              completed_at: new Date().toISOString()
            }
          });
        } catch (cmdErr) {
          await this._rest(`whatsapp_bridge_commands?id=eq.${cmd.id}`, {
            method: 'PATCH',
            body: {
              status: 'error',
              error_message: cmdErr?.message || String(cmdErr),
              completed_at: new Date().toISOString()
            }
          }).catch(() => {});
        }
      }
    } catch {
    } finally {
      this.isProcessingCommands = false;
    }
  }

  async runCronExpirationReminders(targetGymId = null) {
    if (!this.isEnabled()) return null;
    try {
      const params = targetGymId ? { p_target_gym_id: targetGymId } : {};
      const res = await this._rpc('cron_check_whatsapp_expiration_reminders', params);
      if (res.ok) {
        const result = await res.json();
        console.log(`[SecurGYM Cron] ✅ Expiration check complete: ${result?.queued_count ?? 0} queued.`);
        return result;
      }
      // 401/403 happens cleanly when anon key doesn't have service_role permission on restricted RPC
      if (res.status !== 401 && res.status !== 403) {
        console.warn(`[SecurGYM Cron] HTTP ${res.status}`);
      }
    } catch {}
    return null;
  }

  async enqueueOutbox({ toPhone, message, kind = 'manual', pdfBase64 = null, pdfFileName = null, gymId = null }) {
    if (!this.isEnabled()) {
      return await db.enqueueMessage({
        tenantId: 'securgym-cloud-fallback',
        toPhone,
        message,
        pdfBase64,
        pdfFileName,
        kind
      });
    }

    const cleanPhone = normalizePhoneDigits(toPhone, config.securgym?.defaultCountryCode || '509');
    const res = await this._rpc('whatsapp_enqueue_message', {
      p_to_phone: cleanPhone,
      p_message: String(message || '').trim(),
      p_gym_id: gymId || null,
      p_kind: kind,
      p_pdf_base64: pdfBase64 || null,
      p_pdf_file_name: pdfFileName || null
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`SecurGYM enqueue HTTP ${res.status}: ${txt}`);
    }
    const id = await res.json();
    this.lastQueueLength++;
    return { id, to_phone: cleanPhone, kind, status: 'pending' };
  }

  async reportUnrestrict(accountIndex) {
    if (!this.isEnabled()) return;
    this.remoteRestrictedUntil = null;
    await this._rpc('platform_whatsapp_account_unrestrict', {
      p_account_index: parseInt(accountIndex, 10)
    }).catch(() => {});
  }

  getStats() {
    const now = Date.now();
    return {
      enabled: this.isEnabled(),
      accountIndex: this.getAccountIndex(),
      queueLength: this.lastQueueLength,
      dailyReminderCap: this.dailyReminderCap,
      sentRemindersToday: this.sentRemindersToday,
      sentFastToday: this.sentFastToday,
      consecutiveReminders: this.consecutiveReminders,
      nextSlowLaneInSeconds:
        this.nextSlowLaneAllowedAt > now ? Math.ceil((this.nextSlowLaneAllowedAt - now) / 1000) : 0,
      batchPauseInSeconds:
        this.batchPauseUntil > now ? Math.ceil((this.batchPauseUntil - now) / 1000) : 0
    };
  }
}

export const securGymBridge = new SecurGymBridgeWorker();
