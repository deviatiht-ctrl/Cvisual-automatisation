import express from 'express';
import { db } from '../database.js';
import { clusterManager, deliverWebhook } from '../whatsapp/cluster_manager.js';
import { normalizePhoneDigits } from '../whatsapp/account_instance.js';
import {
  authenticateApiKey,
  extractBearerOrApiKey,
  isAdminEmail,
  requireAdmin,
  verifyCvisualSupabaseJwt
} from './middleware.js';
import { applySpintaxAndHashShield } from '../shield.js';
import { config } from '../config.js';
import { buildHtmlDocsPage, buildLlmsTxt, buildOpenApiSpec } from '../docs/api_docs.js';

const router = express.Router();

const FAST_LANE_KINDS = new Set(['receipt', 'welcome', 'otp', 'test', 'manual_direct']);
const SLOW_LANE_KINDS = new Set(['reminder', 'reminder_7d', 'reminder_2d', 'marketing', 'manual']);
const ALL_VALID_KINDS = new Set([...FAST_LANE_KINDS, ...SLOW_LANE_KINDS]);

const PLAN_QUOTA_DEFAULTS = {
  starter: { monthly: 300, daily: 15 },
  pro: { monthly: 3000, daily: 100 },
  enterprise: { monthly: 100000, daily: 5000 }
};

const MAX_MESSAGE_LENGTH = 4096;
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const IDEMPOTENCY_TTL_MS = 15 * 60 * 1000;
const IDEMPOTENCY_MAX_ENTRIES = 2000;

const idempotencyStore = new Map();

function pruneIdempotencyStore(now = Date.now()) {
  for (const [k, entry] of idempotencyStore.entries()) {
    if (now - entry.createdAt > IDEMPOTENCY_TTL_MS) {
      idempotencyStore.delete(k);
    } else {
      break;
    }
  }
  while (idempotencyStore.size >= IDEMPOTENCY_MAX_ENTRIES) {
    const oldestKey = idempotencyStore.keys().next().value;
    if (!oldestKey) break;
    idempotencyStore.delete(oldestKey);
  }
}

function getCachedIdempotency(tenantId, key) {
  if (!key) return null;
  const cacheKey = `${tenantId}:${key}`;
  const entry = idempotencyStore.get(cacheKey);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > IDEMPOTENCY_TTL_MS) {
    idempotencyStore.delete(cacheKey);
    return null;
  }
  return entry;
}

function setCachedIdempotency(tenantId, key, statusCode, body) {
  if (!key) return;
  pruneIdempotencyStore();
  idempotencyStore.set(`${tenantId}:${key}`, {
    statusCode,
    body,
    createdAt: Date.now()
  });
}

function resolveRequestBaseUrl(req) {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https')
    .split(',')[0]
    .trim();
  const host = req.get('host');
  if (host) {
    return `${proto}://${host}`.replace(/\/+$/, '');
  }
  return config.publicUrl;
}

function normalizeAndValidatePhone(rawTo) {
  const clean = normalizePhoneDigits(rawTo, config.securgym?.defaultCountryCode || '509');
  if (!clean || clean.length < 8 || clean.length > 15) {
    return null;
  }
  return clean;
}

function validateAndCleanPdf(rawBase64, rawFileName) {
  if (!rawBase64) {
    return { ok: true, base64: null, fileName: null };
  }
  if (typeof rawBase64 !== 'string') {
    return { ok: false, status: 400, code: 'INVALID_PDF_BASE64', error: 'pdf_base64 must be a base64 string.' };
  }
  let cleaned = rawBase64.trim();
  const marker = 'base64,';
  const idx = cleaned.indexOf(marker);
  if (idx !== -1) {
    cleaned = cleaned.slice(idx + marker.length);
  }
  cleaned = cleaned.replace(/\s+/g, '');

  if (!cleaned || cleaned.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_PDF_BASE64',
      error: 'Invalid pdf_base64 encoding.'
    };
  }

  const decoded = Buffer.from(cleaned, 'base64');
  if (decoded.length === 0) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_PDF_BASE64',
      error: 'Decoded PDF payload is empty.'
    };
  }
  if (decoded.length > MAX_PDF_BYTES) {
    return {
      ok: false,
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
      error: `PDF attachment exceeds maximum limit of ${Math.round(MAX_PDF_BYTES / (1024 * 1024))} MB.`
    };
  }

  let fileName = String(rawFileName || 'Document.pdf').trim() || 'Document.pdf';
  if (!fileName.toLowerCase().endsWith('.pdf')) {
    fileName += '.pdf';
  }
  return { ok: true, base64: cleaned, fileName };
}

async function checkTenantQuota(tenant, additionalCount = 1) {
  const usage = await db.getTenantUsageStats(tenant.id);
  const dailyQuota = Number(tenant.daily_quota ?? 15);
  const monthlyQuota = Number(tenant.monthly_quota ?? 300);

  if (usage.reserved_today + additionalCount > dailyQuota) {
    return {
      ok: false,
      status: 429,
      code: 'DAILY_QUOTA_EXCEEDED',
      error: `Daily quota exceeded (${usage.reserved_today}/${dailyQuota} used today).`,
      usage
    };
  }

  if (usage.reserved_this_month + additionalCount > monthlyQuota) {
    return {
      ok: false,
      status: 429,
      code: 'MONTHLY_QUOTA_EXCEEDED',
      error: `Monthly quota exceeded (${usage.reserved_this_month}/${monthlyQuota} used this month).`,
      usage
    };
  }

  return { ok: true, usage };
}

function maskSecret(secret) {
  if (!secret || typeof secret !== 'string') return null;
  if (secret.length <= 12) return 'whsec_****';
  return `${secret.slice(0, 10)}...${secret.slice(-4)}`;
}

// ==============================================================================
// 0. PUBLIC AI & DEVELOPER DOCUMENTATION ENDPOINTS (ZERO SECRETS)
// ==============================================================================

router.get('/llms.txt', (req, res) => {
  res.type('text/plain; charset=utf-8').send(buildLlmsTxt(resolveRequestBaseUrl(req)));
});

router.get('/openapi.json', (req, res) => {
  res.json(buildOpenApiSpec(resolveRequestBaseUrl(req)));
});

router.get('/docs', (req, res) => {
  const baseUrl = resolveRequestBaseUrl(req);
  const fmt = String(req.query.format || '').toLowerCase();
  if (fmt === 'json') {
    return res.json(buildOpenApiSpec(baseUrl));
  }
  if (fmt === 'md' || fmt === 'markdown' || fmt === 'txt') {
    return res.type('text/plain; charset=utf-8').send(buildLlmsTxt(baseUrl));
  }
  res.type('text/html; charset=utf-8').send(buildHtmlDocsPage(baseUrl));
});

// ==============================================================================
// 1. TENANT PROFILE & CLUSTER STATUS (Authenticated via API Key)
// ==============================================================================

router.get('/me', authenticateApiKey, async (req, res) => {
  try {
    const [usage, accounts] = await Promise.all([
      db.getTenantUsageStats(req.tenant.id),
      db.listAccounts()
    ]);
    const liveAccounts = clusterManager.getAllAccounts();
    const readyCount = liveAccounts.filter(a => a.isReady()).length;
    const baseUrl = resolveRequestBaseUrl(req);

    const dailyQuota = Number(req.tenant.daily_quota ?? 15);
    const monthlyQuota = Number(req.tenant.monthly_quota ?? 300);

    res.json({
      ok: true,
      is_admin: req.isAdmin,
      tenant: {
        id: req.tenant.id,
        name: req.tenant.name,
        email: req.tenant.email,
        plan_tier: req.tenant.plan_tier,
        daily_quota: dailyQuota,
        monthly_quota: monthlyQuota,
        is_active: req.tenant.is_active,
        created_at: req.tenant.created_at
      },
      usage: {
        sent_today: usage.sent_today,
        reserved_today: usage.reserved_today,
        remaining_today: Math.max(0, dailyQuota - usage.reserved_today),
        sent_this_month: usage.sent_this_month,
        reserved_this_month: usage.reserved_this_month,
        remaining_month: Math.max(0, monthlyQuota - usage.reserved_this_month)
      },
      cluster: {
        active_lines_ready: readyCount,
        total_configured_lines: accounts.length
      },
      docs: {
        base_url: baseUrl,
        docs_url: `${baseUrl}/api/v1/docs`,
        llms_url: `${baseUrl}/llms.txt`,
        openapi_url: `${baseUrl}/api/v1/openapi.json`
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, code: 'PROFILE_ERROR', error: err.message });
  }
});

router.get('/status', authenticateApiKey, async (req, res) => {
  try {
    const liveAccounts = clusterManager.getAllAccounts();
    const dbAccounts = await db.listAccounts();
    const readyCount = liveAccounts.filter(a => a.isReady()).length;

    res.json({
      ok: true,
      ready: readyCount > 0,
      ready_lines: readyCount,
      total_lines: Math.max(liveAccounts.length, dbAccounts.length),
      lines: liveAccounts.map(a => ({
        account_index: a.accountIndex,
        status: a.status,
        ready: a.isReady()
      })),
      lanes: {
        fast_lane: {
          kinds: Array.from(FAST_LANE_KINDS),
          supports_sync: true,
          supports_async: true
        },
        slow_lane: {
          kinds: Array.from(SLOW_LANE_KINDS),
          supports_sync: false,
          supports_async: true,
          daily_reminder_cap_per_sim: config.engine.slowLane.dailyReminderLimit,
          min_interval_minutes: Math.round(config.engine.slowLane.minIntervalMs / 60000)
        }
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, code: 'STATUS_ERROR', error: err.message });
  }
});

// ==============================================================================
// 2. NUMBER CHECKER & MESSAGES API (Protected by Tenant API Key)
// ==============================================================================

router.post('/numbers/check', authenticateApiKey, async (req, res) => {
  try {
    const rawPhones = req.body?.phones ?? req.body?.phone;
    const phoneList = Array.isArray(rawPhones) ? rawPhones : rawPhones ? [rawPhones] : [];

    if (phoneList.length === 0) {
      return res.status(400).json({
        ok: false,
        code: 'INVALID_REQUEST',
        error: 'Provide "phones" as an array of 1 to 50 phone numbers.'
      });
    }
    if (phoneList.length > 50) {
      return res.status(400).json({
        ok: false,
        code: 'BATCH_TOO_LARGE',
        error: 'Maximum 50 phone numbers allowed per /numbers/check request.'
      });
    }

    const readyAcc = clusterManager.getPrimaryReadyAccount();
    if (!readyAcc) {
      return res.status(503).json({
        ok: false,
        code: 'WHATSAPP_OFFLINE',
        error: 'No WhatsApp line is currently connected and ready to check numbers.'
      });
    }

    const results = await readyAcc.checkNumbersOnWhatsApp(phoneList);
    res.json({
      ok: true,
      checked_by_account_index: readyAcc.accountIndex,
      count: results.length,
      results
    });
  } catch (err) {
    res.status(500).json({ ok: false, code: 'NUMBER_CHECK_ERROR', error: err.message });
  }
});

/**
 * POST /api/v1/messages/send
 */
router.post('/messages/send', authenticateApiKey, async (req, res) => {
  try {
    const rawIdemKey = req.headers['idempotency-key'] ? String(req.headers['idempotency-key']).trim() : '';
    if (rawIdemKey.length > 128) {
      return res.status(400).json({
        ok: false,
        code: 'INVALID_IDEMPOTENCY_KEY',
        error: 'Idempotency-Key header must be 128 characters or fewer.'
      });
    }

    if (rawIdemKey) {
      const cached = getCachedIdempotency(req.tenant.id, rawIdemKey);
      if (cached) {
        return res.status(cached.statusCode).json({
          ...cached.body,
          idempotent_replay: true
        });
      }
    }

    const {
      to,
      message,
      kind = 'receipt',
      mode = 'async',
      account_index,
      pdf_base64,
      pdfBase64,
      pdf_file_name,
      pdfFileName
    } = req.body || {};

    if (!to || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({
        ok: false,
        code: 'INVALID_REQUEST',
        error: 'Missing required parameters: "to" and non-empty "message" are required.'
      });
    }

    const cleanMessage = message.trim();
    if (cleanMessage.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({
        ok: false,
        code: 'MESSAGE_TOO_LONG',
        error: `Message exceeds maximum length of ${MAX_MESSAGE_LENGTH} characters.`
      });
    }

    const cleanedTo = normalizeAndValidatePhone(to);
    if (!cleanedTo) {
      return res.status(400).json({
        ok: false,
        code: 'INVALID_PHONE',
        error: 'Invalid phone number format. Must contain 8 to 15 digits (8-digit local numbers auto-prefix 509).'
      });
    }

    const messageKind = String(kind || 'receipt').trim().toLowerCase();
    if (!ALL_VALID_KINDS.has(messageKind)) {
      return res.status(400).json({
        ok: false,
        code: 'INVALID_KIND',
        error: `Invalid message kind "${messageKind}". Allowed: ${Array.from(ALL_VALID_KINDS).join(', ')}`
      });
    }

    const isFastLane = FAST_LANE_KINDS.has(messageKind);
    const reqMode = String(mode || 'async').trim().toLowerCase();
    if (reqMode !== 'async' && reqMode !== 'sync') {
      return res.status(400).json({
        ok: false,
        code: 'INVALID_MODE',
        error: 'Parameter "mode" must be either "async" or "sync".'
      });
    }

    if (reqMode === 'sync' && !isFastLane) {
      return res.status(422).json({
        ok: false,
        code: 'SYNC_NOT_ALLOWED_FOR_SLOW_LANE',
        error: `Synchronous mode is restricted to Fast Lane kinds (${Array.from(FAST_LANE_KINDS).join(', ')}). Use mode="async" for Slow Lane kinds.`
      });
    }

    let preferredAccountIndex = null;
    if (account_index !== undefined && account_index !== null && account_index !== '') {
      const parsedIdx = parseInt(account_index, 10);
      if (!Number.isInteger(parsedIdx) || parsedIdx < 1) {
        return res.status(400).json({
          ok: false,
          code: 'INVALID_ACCOUNT_INDEX',
          error: 'account_index must be a positive integer.'
        });
      }
      preferredAccountIndex = parsedIdx;
    }

    const pdfValidation = validateAndCleanPdf(pdf_base64 || pdfBase64 || null, pdf_file_name || pdfFileName);
    if (!pdfValidation.ok) {
      return res.status(pdfValidation.status).json({
        ok: false,
        code: pdfValidation.code,
        error: pdfValidation.error
      });
    }

    const quotaCheck = await checkTenantQuota(req.tenant, 1);
    if (!quotaCheck.ok) {
      return res.status(quotaCheck.status).json({
        ok: false,
        code: quotaCheck.code,
        error: quotaCheck.error
      });
    }

    if (reqMode === 'sync') {
      if (preferredAccountIndex !== null) {
        const target = clusterManager.getAccount(preferredAccountIndex);
        if (!target || !target.isReady()) {
          return res.status(503).json({
            ok: false,
            code: 'WHATSAPP_OFFLINE',
            error: `WhatsApp line #${preferredAccountIndex} is not connected or ready right now.`
          });
        }
      } else if (!clusterManager.getPrimaryReadyAccount()) {
        return res.status(503).json({
          ok: false,
          code: 'WHATSAPP_OFFLINE',
          error: 'No WhatsApp line is currently connected for synchronous delivery. Use mode="async" to queue the message.'
        });
      }

      try {
        const sendResult = await clusterManager.sendMessageAnywhere({
          to: cleanedTo,
          message: cleanMessage,
          pdfBase64: pdfValidation.base64,
          pdfFileName: pdfValidation.fileName,
          kind: messageKind,
          preferredAccountIndex
        });

        const sentAt = new Date().toISOString();
        const logged = await db.enqueueMessage({
          tenantId: req.tenant.id,
          toPhone: cleanedTo,
          message: cleanMessage,
          pdfBase64: null,
          pdfFileName: pdfValidation.fileName,
          kind: messageKind,
          status: 'sent',
          assignedAccountIndex: sendResult.accountIndex,
          sentByPhone: sendResult.fromPhone || null,
          sentAt
        });

        await clusterManager.dispatchWebhooks(req.tenant.id, 'message.sent', {
          message_id: logged.id,
          tenant_id: req.tenant.id,
          to_phone: cleanedTo,
          kind: messageKind,
          lane: 'fast_lane',
          account_index: sendResult.accountIndex,
          sent_by_phone: sendResult.fromPhone || null,
          whatsapp_message_id: sendResult.whatsappMessageId || null,
          sent_at: sentAt
        });

        const responseBody = {
          ok: true,
          message_id: logged.id,
          status: 'sent',
          lane: 'fast_lane',
          kind: messageKind,
          recipient: cleanedTo,
          account_index: sendResult.accountIndex,
          sent_by_phone: sendResult.fromPhone || null,
          whatsapp_message_id: sendResult.whatsappMessageId || null,
          has_pdf: Boolean(pdfValidation.base64),
          note: 'Message delivered immediately via Fast Lane.'
        };
        setCachedIdempotency(req.tenant.id, rawIdemKey, 200, responseBody);
        return res.status(200).json(responseBody);
      } catch (syncErr) {
        const errMsg = syncErr?.message || String(syncErr);
        const isOffline =
          errMsg.includes('Okenn liy WhatsApp pa pare') || errMsg.includes('pa konekte oswa pa prè');
        if (isOffline) {
          return res.status(503).json({
            ok: false,
            code: 'WHATSAPP_OFFLINE',
            error: errMsg
          });
        }

        const loggedFail = await db.enqueueMessage({
          tenantId: req.tenant.id,
          toPhone: cleanedTo,
          message: cleanMessage,
          pdfBase64: null,
          pdfFileName: pdfValidation.fileName,
          kind: messageKind,
          status: 'failed',
          assignedAccountIndex: preferredAccountIndex
        });
        await db.updateMessageStatus(loggedFail.id, 'failed', { errorMessage: errMsg });
        await clusterManager.dispatchWebhooks(req.tenant.id, 'message.failed', {
          message_id: loggedFail.id,
          tenant_id: req.tenant.id,
          to_phone: cleanedTo,
          kind: messageKind,
          lane: 'fast_lane',
          error_message: errMsg
        });

        const isUnregistered = errMsg.includes('pa anrejistre sou WhatsApp');
        return res.status(isUnregistered ? 422 : 502).json({
          ok: false,
          code: isUnregistered ? 'UNREGISTERED_WHATSAPP_NUMBER' : 'DELIVERY_FAILED',
          message_id: loggedFail.id,
          error: errMsg
        });
      }
    }

    // Async queue delivery (default)
    const outboxMessage = await db.enqueueMessage({
      tenantId: req.tenant.id,
      toPhone: cleanedTo,
      message: cleanMessage,
      pdfBase64: pdfValidation.base64,
      pdfFileName: pdfValidation.fileName,
      kind: messageKind,
      assignedAccountIndex: preferredAccountIndex
    });

    const responseBody = {
      ok: true,
      message_id: outboxMessage.id,
      status: 'queued',
      lane: isFastLane ? 'fast_lane' : 'slow_lane',
      kind: messageKind,
      recipient: cleanedTo,
      account_index: preferredAccountIndex,
      has_pdf: Boolean(pdfValidation.base64),
      note: isFastLane
        ? 'Message sent to Fast Lane for immediate organic delivery.'
        : 'Message scheduled in Anti-Ban Slow Lane with organic 10-16 min pacing.'
    };
    setCachedIdempotency(req.tenant.id, rawIdemKey, 202, responseBody);
    return res.status(202).json(responseBody);
  } catch (err) {
    console.error('[API Send Message Error]:', err);
    res.status(500).json({ ok: false, code: 'SEND_ERROR', error: err.message });
  }
});

/**
 * POST /api/v1/messages/send-bulk
 * Up to 100 messages queued atomically after validation & quota check
 */
router.post('/messages/send-bulk', authenticateApiKey, async (req, res) => {
  try {
    const rawItems = req.body?.messages;
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      return res.status(400).json({
        ok: false,
        code: 'INVALID_REQUEST',
        error: 'Provide "messages" as a non-empty array (max 100 items).'
      });
    }
    if (rawItems.length > 100) {
      return res.status(400).json({
        ok: false,
        code: 'BATCH_TOO_LARGE',
        error: 'Maximum 100 messages allowed per /messages/send-bulk request.'
      });
    }

    const prepared = [];
    const errors = [];

    for (let i = 0; i < rawItems.length; i++) {
      const item = rawItems[i] || {};
      const cleanedTo = normalizeAndValidatePhone(item.to);
      if (!cleanedTo) {
        errors.push({ index: i, code: 'INVALID_PHONE', error: 'Invalid recipient phone.' });
        continue;
      }

      const msgText = typeof item.message === 'string' ? item.message.trim() : '';
      if (!msgText) {
        errors.push({ index: i, code: 'INVALID_REQUEST', error: 'Message text is required.' });
        continue;
      }
      if (msgText.length > MAX_MESSAGE_LENGTH) {
        errors.push({ index: i, code: 'MESSAGE_TOO_LONG', error: `Message exceeds ${MAX_MESSAGE_LENGTH} chars.` });
        continue;
      }

      const kindVal = String(item.kind || 'reminder').trim().toLowerCase();
      if (!ALL_VALID_KINDS.has(kindVal)) {
        errors.push({ index: i, code: 'INVALID_KIND', error: `Unsupported kind "${kindVal}".` });
        continue;
      }

      let accIdx = null;
      if (item.account_index !== undefined && item.account_index !== null && item.account_index !== '') {
        const parsedIdx = parseInt(item.account_index, 10);
        if (!Number.isInteger(parsedIdx) || parsedIdx < 1) {
          errors.push({ index: i, code: 'INVALID_ACCOUNT_INDEX', error: 'Invalid account_index.' });
          continue;
        }
        accIdx = parsedIdx;
      }

      const pdfCheck = validateAndCleanPdf(
        item.pdf_base64 || item.pdfBase64 || null,
        item.pdf_file_name || item.pdfFileName
      );
      if (!pdfCheck.ok) {
        errors.push({ index: i, code: pdfCheck.code, error: pdfCheck.error });
        continue;
      }

      prepared.push({
        toPhone: cleanedTo,
        message: msgText,
        kind: kindVal,
        assignedAccountIndex: accIdx,
        pdfBase64: pdfCheck.base64,
        pdfFileName: pdfCheck.fileName
      });
    }

    if (errors.length > 0) {
      return res.status(400).json({
        ok: false,
        code: 'INVALID_BULK_ITEMS',
        error: `${errors.length} item(s) failed validation.`,
        errors
      });
    }

    const quotaCheck = await checkTenantQuota(req.tenant, prepared.length);
    if (!quotaCheck.ok) {
      return res.status(quotaCheck.status).json({
        ok: false,
        code: quotaCheck.code,
        error: quotaCheck.error
      });
    }

    const queued = [];
    for (const p of prepared) {
      const saved = await db.enqueueMessage({
        tenantId: req.tenant.id,
        toPhone: p.toPhone,
        message: p.message,
        pdfBase64: p.pdfBase64,
        pdfFileName: p.pdfFileName,
        kind: p.kind,
        assignedAccountIndex: p.assignedAccountIndex
      });
      queued.push({
        message_id: saved.id,
        recipient: p.toPhone,
        kind: p.kind,
        lane: FAST_LANE_KINDS.has(p.kind) ? 'fast_lane' : 'slow_lane',
        status: 'queued'
      });
    }

    res.status(202).json({
      ok: true,
      count: queued.length,
      results: queued
    });
  } catch (err) {
    res.status(500).json({ ok: false, code: 'BULK_SEND_ERROR', error: err.message });
  }
});

/**
 * GET /api/v1/messages/:id/status
 */
router.get('/messages/:id/status', authenticateApiKey, async (req, res) => {
  try {
    const { id } = req.params;
    const msg = await db.getMessageById(id);

    if (!msg) {
      return res.status(404).json({ ok: false, code: 'NOT_FOUND', error: 'Message not found' });
    }

    if (msg.tenant_id !== req.tenant.id && !req.isAdmin) {
      return res.status(403).json({ ok: false, code: 'FORBIDDEN', error: 'Access denied to this message.' });
    }

    res.json({
      ok: true,
      message: {
        id: msg.id,
        status: msg.status,
        kind: msg.kind,
        lane: FAST_LANE_KINDS.has(msg.kind) ? 'fast_lane' : 'slow_lane',
        to_phone: msg.to_phone,
        has_pdf: Boolean(msg.pdf_file_name || msg.pdf_base64),
        pdf_file_name: msg.pdf_file_name || null,
        assigned_account_index: msg.assigned_account_index,
        sent_by_phone: msg.sent_by_phone,
        retry_count: msg.retry_count,
        error_message: msg.error_message,
        created_at: msg.created_at,
        sent_at: msg.sent_at
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, code: 'STATUS_LOOKUP_ERROR', error: err.message });
  }
});

/**
 * POST /api/v1/messages/:id/cancel
 */
router.post('/messages/:id/cancel', authenticateApiKey, async (req, res) => {
  try {
    const { id } = req.params;
    const msg = await db.getMessageById(id);
    if (!msg) {
      return res.status(404).json({ ok: false, code: 'NOT_FOUND', error: 'Message not found' });
    }
    if (msg.tenant_id !== req.tenant.id && !req.isAdmin) {
      return res.status(403).json({ ok: false, code: 'FORBIDDEN', error: 'Access denied to this message.' });
    }

    const result = await db.cancelPendingMessage(id);
    if (!result.ok) {
      return res.status(409).json({
        ok: false,
        code: result.reason,
        error: `Cannot cancel message in state "${result.currentStatus}". Only pending messages can be cancelled.`
      });
    }

    res.json({ ok: true, message: result.message });
  } catch (err) {
    res.status(500).json({ ok: false, code: 'CANCEL_ERROR', error: err.message });
  }
});

/**
 * POST /api/v1/messages/:id/retry
 */
router.post('/messages/:id/retry', authenticateApiKey, async (req, res) => {
  try {
    const { id } = req.params;
    const msg = await db.getMessageById(id);
    if (!msg) {
      return res.status(404).json({ ok: false, code: 'NOT_FOUND', error: 'Message not found' });
    }
    if (msg.tenant_id !== req.tenant.id && !req.isAdmin) {
      return res.status(403).json({ ok: false, code: 'FORBIDDEN', error: 'Access denied to this message.' });
    }

    const result = await db.retryMessage(id);
    if (!result.ok) {
      return res.status(409).json({
        ok: false,
        code: result.reason,
        error: `Cannot retry message in state "${result.currentStatus}".`
      });
    }

    res.json({ ok: true, message: result.message });
  } catch (err) {
    res.status(500).json({ ok: false, code: 'RETRY_ERROR', error: err.message });
  }
});

/**
 * GET /api/v1/messages
 * List recent messages for tenant
 */
router.get('/messages', authenticateApiKey, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '50', 10);
    const offset = parseInt(req.query.offset || '0', 10);
    const status = req.query.status || null;
    const kind = req.query.kind || null;

    const messages = await db.listMessages({
      tenantId: req.tenant.id,
      limit,
      offset,
      status,
      kind
    });

    res.json({ ok: true, count: messages.length, messages });
  } catch (err) {
    res.status(500).json({ ok: false, code: 'LIST_MESSAGES_ERROR', error: err.message });
  }
});

// ==============================================================================
// 3. WHATSAPP ACCOUNTS CLUSTER MANAGEMENT (Protected by Admin Auth)
// ==============================================================================

router.get('/accounts', requireAdmin, async (req, res) => {
  try {
    const dbAccounts = await db.listAccounts();
    const liveAccounts = clusterManager.getAllAccounts();

    const formatted = dbAccounts.map(dbAcc => {
      const live = liveAccounts.find(l => l.accountIndex === dbAcc.account_index);
      return {
        ...dbAcc,
        is_live_connected: live ? live.isReady() : false,
        memory_status: live ? live.status : 'OFFLINE'
      };
    });

    res.json({ ok: true, count: formatted.length, accounts: formatted });
  } catch (err) {
    res.status(500).json({ ok: false, code: 'ACCOUNTS_LIST_ERROR', error: err.message });
  }
});

router.get('/accounts/:index/qr', requireAdmin, async (req, res) => {
  try {
    const index = parseInt(req.params.index, 10);
    const dbAcc = await db.getAccountByIndex(index);
    const liveAcc = clusterManager.getAccount(index);

    if (!dbAcc && !liveAcc) {
      return res.status(404).json({ ok: false, code: 'NOT_FOUND', error: `Account line ${index} not found.` });
    }

    const qrUrl = liveAcc?.qrCodeDataUrl || dbAcc?.qr_code_data_url || null;
    const status = liveAcc?.status || dbAcc?.service_status || 'DISCONNECTED';

    res.json({
      ok: true,
      account_index: index,
      service_status: status,
      qr_code_data_url: qrUrl,
      is_ready: liveAcc ? liveAcc.isReady() : false,
      phone_number: liveAcc?.phoneNumber || dbAcc?.phone_number || null
    });
  } catch (err) {
    res.status(500).json({ ok: false, code: 'QR_FETCH_ERROR', error: err.message });
  }
});

router.post('/accounts/:index/reset', requireAdmin, async (req, res) => {
  try {
    const index = parseInt(req.params.index, 10);
    const result = await clusterManager.resetAccount(index, { awaitInit: false });
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, code: 'ACCOUNT_RESET_ERROR', error: err.message });
  }
});

// ==============================================================================
// 4. WEBHOOKS & SHIELD TOOLS
// ==============================================================================

router.get('/webhooks', authenticateApiKey, async (req, res) => {
  try {
    const list = await db.listWebhooks(req.tenant.id);
    res.json({
      ok: true,
      count: list.length,
      webhooks: list.map(w => ({
        id: w.id,
        tenant_id: w.tenant_id,
        url: w.url,
        events: w.events,
        secret_preview: maskSecret(w.secret),
        created_at: w.created_at
      }))
    });
  } catch (err) {
    res.status(500).json({ ok: false, code: 'WEBHOOK_LIST_ERROR', error: err.message });
  }
});

router.post('/webhooks/register', authenticateApiKey, async (req, res) => {
  try {
    const { url, events, secret } = req.body || {};
    if (!url || typeof url !== 'string') {
      return res.status(400).json({
        ok: false,
        code: 'INVALID_WEBHOOK_URL',
        error: 'Webhook URL is required.'
      });
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(url.trim());
    } catch {
      return res.status(400).json({
        ok: false,
        code: 'INVALID_WEBHOOK_URL',
        error: 'Malformed webhook URL.'
      });
    }

    if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
      return res.status(400).json({
        ok: false,
        code: 'INVALID_WEBHOOK_URL',
        error: 'Webhook URL must start with https:// or http://'
      });
    }

    const normalizedEvents =
      Array.isArray(events) && events.length > 0
        ? events.map(e => String(e).trim()).filter(Boolean)
        : ['message.sent', 'message.failed'];

    const webhook = await db.registerWebhook({
      tenantId: req.tenant.id,
      url: parsedUrl.toString(),
      events: normalizedEvents,
      secret: secret ? String(secret).trim() : null
    });

    res.status(201).json({ ok: true, webhook });
  } catch (err) {
    res.status(500).json({ ok: false, code: 'WEBHOOK_REGISTER_ERROR', error: err.message });
  }
});

router.delete('/webhooks/:id', authenticateApiKey, async (req, res) => {
  try {
    const { id } = req.params;
    const wh = await db.getWebhookById(id);
    if (!wh) {
      return res.status(404).json({ ok: false, code: 'NOT_FOUND', error: 'Webhook not found.' });
    }
    if (wh.tenant_id !== req.tenant.id && !req.isAdmin) {
      return res.status(403).json({ ok: false, code: 'FORBIDDEN', error: 'Access denied to this webhook.' });
    }

    await db.deleteWebhook(id);
    res.json({ ok: true, deleted_id: id });
  } catch (err) {
    res.status(500).json({ ok: false, code: 'WEBHOOK_DELETE_ERROR', error: err.message });
  }
});

router.post('/webhooks/:id/test', authenticateApiKey, async (req, res) => {
  try {
    const { id } = req.params;
    const wh = await db.getWebhookById(id);
    if (!wh) {
      return res.status(404).json({ ok: false, code: 'NOT_FOUND', error: 'Webhook not found.' });
    }
    if (wh.tenant_id !== req.tenant.id && !req.isAdmin) {
      return res.status(403).json({ ok: false, code: 'FORBIDDEN', error: 'Access denied to this webhook.' });
    }

    const delivery = await deliverWebhook(wh, 'webhook.test', {
      test: true,
      webhook_id: wh.id,
      tenant_id: req.tenant.id,
      message: 'CVISUAL WhatsApp Gateway test webhook event'
    });

    res.status(delivery.ok ? 200 : 502).json({
      ok: delivery.ok,
      webhook_id: wh.id,
      delivery
    });
  } catch (err) {
    res.status(500).json({ ok: false, code: 'WEBHOOK_TEST_ERROR', error: err.message });
  }
});

/**
 * POST /api/v1/shield/preview
 */
router.post('/shield/preview', (req, res) => {
  try {
    const { text, kind = 'receipt' } = req.body || {};
    if (!text) {
      return res.status(400).json({ ok: false, code: 'INVALID_REQUEST', error: 'Text parameter is required.' });
    }

    const isReminder = SLOW_LANE_KINDS.has(String(kind || '').toLowerCase().trim());
    const result = applySpintaxAndHashShield(text, {
      forceEngagement: isReminder,
      applyDoNotReply: isReminder
    });

    res.json({
      ok: true,
      preview: {
        raw_text: result.rawText,
        shielded_text: result.processedText,
        original_sha256: result.originalHash,
        shielded_sha256: result.shieldedHash,
        invisible_unicode_count: result.injectedCount,
        typing_simulation_ms: result.typingSimulationMs
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, code: 'SHIELD_ERROR', error: err.message });
  }
});

// ==============================================================================
// 5. SAAS AUTH SYNC & USER PROFILE (Hardened JWT Verification)
// ==============================================================================

router.post('/auth/sync', async (req, res) => {
  try {
    const token = extractBearerOrApiKey(req);
    let verifiedUser = null;

    if (token) {
      verifiedUser = await verifyCvisualSupabaseJwt(token);
    }

    let userId = null;
    let cleanEmail = '';
    let companyName = req.body?.companyName || null;
    const requestedPlan = req.body?.requestedPlan || null;

    if (verifiedUser) {
      userId = verifiedUser.id || null;
      cleanEmail = String(verifiedUser.email || '').trim().toLowerCase();
      companyName =
        companyName ||
        verifiedUser.user_metadata?.company_name ||
        verifiedUser.user_metadata?.full_name ||
        null;
    } else if (!db.isConfigured() && config.nodeEnv !== 'production') {
      // Explicit local/memory dev fallback when Supabase Auth is not connected
      const rawEmail = req.body?.email;
      if (!rawEmail) {
        return res.status(400).json({ ok: false, code: 'INVALID_REQUEST', error: 'Email is required.' });
      }
      userId = req.body?.userId || null;
      cleanEmail = String(rawEmail).trim().toLowerCase();
    } else {
      return res.status(401).json({
        ok: false,
        code: 'UNAUTHORIZED',
        error: 'Valid authenticated CVISUAL session token required for /auth/sync.'
      });
    }

    if (!cleanEmail) {
      return res.status(400).json({ ok: false, code: 'INVALID_EMAIL', error: 'User email not present in session.' });
    }

    const isAdmin = isAdminEmail(cleanEmail);

    let tenant = null;
    if (userId) {
      tenant = await db.getTenantByUserId(userId);
    }

    if (!tenant) {
      tenant = await db.getTenantByEmail(cleanEmail);
      if (tenant && userId && !tenant.user_id) {
        tenant = await db.updateTenant(tenant.id, { user_id: userId });
      }
    }

    if (!tenant) {
      const plan = PLAN_QUOTA_DEFAULTS[requestedPlan] ? requestedPlan : isAdmin ? 'enterprise' : 'starter';
      const quotas = PLAN_QUOTA_DEFAULTS[plan];

      tenant = await db.createTenant({
        userId: userId || null,
        name: companyName || (isAdmin ? 'CVISUAL Admin Command Center' : 'Nouvo Kliyan'),
        email: cleanEmail,
        planTier: plan,
        monthlyQuota: quotas.monthly,
        dailyQuota: quotas.daily,
        isActive: isAdmin
      });

      if (!isAdmin) {
        await db.createPlanRequest({
          userId: userId || null,
          email: cleanEmail,
          companyName: companyName || 'Nouvo Kliyan',
          requestedPlan: plan
        });
      }
    } else if (isAdmin && !tenant.is_active) {
      tenant = await db.updateTenant(tenant.id, { is_active: true });
    }

    res.json({
      ok: true,
      isAdmin,
      tenant
    });
  } catch (err) {
    console.error('[Auth Sync Error]:', err);
    res.status(500).json({ ok: false, code: 'AUTH_SYNC_ERROR', error: err.message });
  }
});

router.post('/plans/request', async (req, res) => {
  try {
    const token = extractBearerOrApiKey(req);
    let verifiedEmail = null;
    let verifiedUserId = null;

    if (token) {
      const u = await verifyCvisualSupabaseJwt(token);
      if (u?.email) {
        verifiedEmail = u.email.trim().toLowerCase();
        verifiedUserId = u.id || null;
      }
    }

    const { userId, email, companyName, requestedPlan, phoneNumber } = req.body || {};
    const effectiveEmail = verifiedEmail || (email ? String(email).trim().toLowerCase() : '');

    if (!effectiveEmail || !requestedPlan) {
      return res.status(400).json({
        ok: false,
        code: 'INVALID_REQUEST',
        error: 'Email and requestedPlan are required.'
      });
    }

    const request = await db.createPlanRequest({
      userId: verifiedUserId || userId || null,
      email: effectiveEmail,
      companyName: companyName || 'Kliyan',
      requestedPlan,
      phoneNumber
    });

    res.json({
      ok: true,
      message: 'Plan request submitted successfully. Administrator will review shortly.',
      request
    });
  } catch (err) {
    res.status(500).json({ ok: false, code: 'PLAN_REQUEST_ERROR', error: err.message });
  }
});

// ==============================================================================
// 6. ADMIN CONTROL PANEL & API KEYS MANAGEMENT ENDPOINTS
// ==============================================================================

router.get('/admin/overview', requireAdmin, async (req, res) => {
  try {
    const [tenants, accounts, messages, requests] = await Promise.all([
      db.listTenants(),
      db.listAccounts(),
      db.listMessages({ limit: 100 }),
      db.listPlanRequests('pending')
    ]);

    const stats = {
      totalTenants: tenants.length,
      activeTenants: tenants.filter(t => t.is_active).length,
      pendingValidationCount: requests.length,
      totalLines: accounts.length,
      readyLines: accounts.filter(a => a.service_status === 'READY').length,
      messagesTotalRecent: messages.length,
      messagesSentRecent: messages.filter(m => m.status === 'sent').length
    };

    res.json({ ok: true, stats });
  } catch (err) {
    res.status(500).json({ ok: false, code: 'ADMIN_OVERVIEW_ERROR', error: err.message });
  }
});

router.get('/admin/master-key', requireAdmin, async (req, res) => {
  try {
    const preferredEmail = req.tenant?.email || req.adminEmail || null;
    const tenant =
      req.tenant && isAdminEmail(req.tenant.email)
        ? req.tenant
        : await db.getOrEnsureAdminTenant(preferredEmail);
    const usage = await db.getTenantUsageStats(tenant.id);
    const baseUrl = resolveRequestBaseUrl(req);

    res.json({
      ok: true,
      tenant,
      usage,
      integration: {
        base_url: baseUrl,
        docs_url: `${baseUrl}/api/v1/docs`,
        llms_url: `${baseUrl}/llms.txt`,
        openapi_url: `${baseUrl}/api/v1/openapi.json`
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, code: 'MASTER_KEY_ERROR', error: err.message });
  }
});

router.get('/admin/api-keys', requireAdmin, async (req, res) => {
  try {
    const [tenants, usageMap] = await Promise.all([db.listTenants(), db.getUsageByTenantMap()]);
    const enriched = tenants.map(t => ({
      ...t,
      is_master_admin: Boolean(t.email && isAdminEmail(t.email)),
      usage: usageMap.get(t.id) || {
        sent_today: 0,
        sent_this_month: 0,
        reserved_today: 0,
        reserved_this_month: 0
      }
    }));

    res.json({ ok: true, count: enriched.length, tenants: enriched });
  } catch (err) {
    res.status(500).json({ ok: false, code: 'LIST_KEYS_ERROR', error: err.message });
  }
});

router.post('/admin/api-keys', requireAdmin, async (req, res) => {
  try {
    const {
      name,
      email = null,
      plan_tier = 'pro',
      daily_quota,
      monthly_quota,
      is_active = true
    } = req.body || {};

    if (!name || !String(name).trim()) {
      return res.status(400).json({
        ok: false,
        code: 'INVALID_REQUEST',
        error: 'Le nom du site ou de l’application (name) est obligatoire.'
      });
    }

    const cleanPlan = PLAN_QUOTA_DEFAULTS[plan_tier] ? plan_tier : 'pro';
    const defaults = PLAN_QUOTA_DEFAULTS[cleanPlan];

    const parsedDaily =
      daily_quota !== undefined && daily_quota !== null && daily_quota !== ''
        ? parseInt(daily_quota, 10)
        : defaults.daily;
    const parsedMonthly =
      monthly_quota !== undefined && monthly_quota !== null && monthly_quota !== ''
        ? parseInt(monthly_quota, 10)
        : defaults.monthly;

    if (!Number.isInteger(parsedDaily) || parsedDaily < 1 || !Number.isInteger(parsedMonthly) || parsedMonthly < 1) {
      return res.status(400).json({
        ok: false,
        code: 'INVALID_QUOTA',
        error: 'daily_quota and monthly_quota must be positive integers.'
      });
    }

    const tenant = await db.createTenant({
      userId: null,
      name: String(name).trim(),
      email: email && String(email).trim() ? String(email).trim().toLowerCase() : null,
      planTier: cleanPlan,
      dailyQuota: parsedDaily,
      monthlyQuota: parsedMonthly,
      isActive: Boolean(is_active)
    });

    res.status(201).json({
      ok: true,
      tenant,
      message: 'Nouvelle clé API créée avec succès.'
    });
  } catch (err) {
    res.status(500).json({ ok: false, code: 'CREATE_KEY_ERROR', error: err.message });
  }
});

router.post('/admin/api-keys/:id/rotate', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await db.getTenantById(id);
    if (!existing) {
      return res.status(404).json({ ok: false, code: 'NOT_FOUND', error: 'Tenant API key not found.' });
    }

    const updated = await db.rotateTenantApiKey(id);
    res.json({
      ok: true,
      tenant: updated,
      message: 'Clé API régénérée avec succès.'
    });
  } catch (err) {
    res.status(500).json({ ok: false, code: 'ROTATE_KEY_ERROR', error: err.message });
  }
});

router.get('/admin/settings', requireAdmin, (req, res) => {
  res.json({
    ok: true,
    settings: {
      dailyReminderLimit: config.engine.slowLane.dailyReminderLimit,
      slowLaneIntervalMinutes: Math.round(config.engine.slowLane.minIntervalMs / 60000),
      slowLaneJitterSeconds: Math.round(config.engine.slowLane.maxJitterMs / 1000),
      batchPauseThreshold: config.engine.slowLane.batchPauseThreshold,
      batchPauseMinutes: Math.round(config.engine.slowLane.batchPauseDurationMs / 60000),
      fastLaneMinSeconds: Math.round(config.engine.fastLane.minDelayMs / 1000),
      fastLaneMaxSeconds: Math.round(config.engine.fastLane.maxDelayMs / 1000)
    }
  });
});

router.post('/admin/settings', requireAdmin, async (req, res) => {
  try {
    const {
      dailyReminderLimit,
      slowLaneIntervalMinutes,
      slowLaneJitterSeconds,
      batchPauseThreshold,
      batchPauseMinutes,
      fastLaneMinSeconds,
      fastLaneMaxSeconds
    } = req.body || {};

    if (dailyReminderLimit !== undefined) {
      config.engine.slowLane.dailyReminderLimit = parseInt(dailyReminderLimit, 10);
      const accounts = await db.listAccounts();
      for (const acc of accounts) {
        await db.updateAccountStatus(acc.account_index, acc.service_status || 'DISCONNECTED', {
          daily_reminder_limit: parseInt(dailyReminderLimit, 10)
        });
      }
    }

    if (slowLaneIntervalMinutes !== undefined) {
      config.engine.slowLane.minIntervalMs = parseInt(slowLaneIntervalMinutes, 10) * 60000;
    }

    if (slowLaneJitterSeconds !== undefined) {
      config.engine.slowLane.maxJitterMs = parseInt(slowLaneJitterSeconds, 10) * 1000;
    }

    if (batchPauseThreshold !== undefined) {
      config.engine.slowLane.batchPauseThreshold = parseInt(batchPauseThreshold, 10);
    }

    if (batchPauseMinutes !== undefined) {
      config.engine.slowLane.batchPauseDurationMs = parseInt(batchPauseMinutes, 10) * 60000;
    }

    if (fastLaneMinSeconds !== undefined) {
      config.engine.fastLane.minDelayMs = parseInt(fastLaneMinSeconds, 10) * 1000;
    }

    if (fastLaneMaxSeconds !== undefined) {
      config.engine.fastLane.maxDelayMs = parseInt(fastLaneMaxSeconds, 10) * 1000;
    }

    console.log('[Admin Settings] Règles de temporisation mises à jour avec succès.');

    res.json({
      ok: true,
      message: 'Paramètres mis à jour avec succès.',
      settings: {
        dailyReminderLimit: config.engine.slowLane.dailyReminderLimit,
        slowLaneIntervalMinutes: Math.round(config.engine.slowLane.minIntervalMs / 60000),
        slowLaneJitterSeconds: Math.round(config.engine.slowLane.maxJitterMs / 1000),
        batchPauseThreshold: config.engine.slowLane.batchPauseThreshold,
        batchPauseMinutes: Math.round(config.engine.slowLane.batchPauseDurationMs / 60000),
        fastLaneMinSeconds: Math.round(config.engine.fastLane.minDelayMs / 1000),
        fastLaneMaxSeconds: Math.round(config.engine.fastLane.maxDelayMs / 1000)
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, code: 'SETTINGS_UPDATE_ERROR', error: err.message });
  }
});

router.get('/admin/tenants', requireAdmin, async (req, res) => {
  try {
    const tenants = await db.listTenants();
    res.json({ ok: true, count: tenants.length, tenants });
  } catch (err) {
    res.status(500).json({ ok: false, code: 'TENANTS_LIST_ERROR', error: err.message });
  }
});

router.patch('/admin/tenants/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await db.getTenantById(id);
    if (!existing) {
      return res.status(404).json({ ok: false, code: 'NOT_FOUND', error: 'Tenant not found.' });
    }

    const { name, email, plan_tier, daily_quota, monthly_quota, is_active } = req.body || {};
    const updates = {};

    if (name !== undefined && String(name).trim()) {
      updates.name = String(name).trim();
    }
    if (email !== undefined) {
      updates.email = email && String(email).trim() ? String(email).trim().toLowerCase() : null;
    }
    if (plan_tier !== undefined && PLAN_QUOTA_DEFAULTS[plan_tier]) {
      updates.plan_tier = plan_tier;
      if (daily_quota === undefined) {
        updates.daily_quota = PLAN_QUOTA_DEFAULTS[plan_tier].daily;
      }
      if (monthly_quota === undefined) {
        updates.monthly_quota = PLAN_QUOTA_DEFAULTS[plan_tier].monthly;
      }
    }
    if (daily_quota !== undefined && Number.isInteger(parseInt(daily_quota, 10))) {
      updates.daily_quota = Math.max(1, parseInt(daily_quota, 10));
    }
    if (monthly_quota !== undefined && Number.isInteger(parseInt(monthly_quota, 10))) {
      updates.monthly_quota = Math.max(1, parseInt(monthly_quota, 10));
    }
    if (is_active !== undefined) {
      updates.is_active = Boolean(is_active);
    }

    const updated = await db.updateTenant(id, updates);
    res.json({ ok: true, tenant: updated, message: 'Locataire mis à jour avec succès.' });
  } catch (err) {
    res.status(500).json({ ok: false, code: 'TENANT_UPDATE_ERROR', error: err.message });
  }
});

router.delete('/admin/tenants/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await db.getTenantById(id);
    if (!existing) {
      return res.status(404).json({ ok: false, code: 'NOT_FOUND', error: 'Tenant not found.' });
    }

    if (existing.email && isAdminEmail(existing.email)) {
      const all = await db.listTenants();
      const sameAdminTenants = all.filter(t => t.email && t.email.toLowerCase() === existing.email.toLowerCase());
      if (sameAdminTenants.length <= 1) {
        return res.status(400).json({
          ok: false,
          code: 'CANNOT_DELETE_PRIMARY_ADMIN',
          error: 'La clé Master Admin principale ne peut pas être supprimée (utilisez Régénérer si nécessaire).'
        });
      }
    }

    await db.deleteTenant(id);
    res.json({ ok: true, deleted_id: id, message: 'Clé API supprimée.' });
  } catch (err) {
    res.status(500).json({ ok: false, code: 'TENANT_DELETE_ERROR', error: err.message });
  }
});

router.post('/admin/tenants/:id/activate', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { is_active = true, plan_tier } = req.body || {};

    const updates = { is_active: Boolean(is_active) };
    if (plan_tier) {
      const plan = PLAN_QUOTA_DEFAULTS[plan_tier] ? plan_tier : 'starter';
      updates.plan_tier = plan;
      updates.monthly_quota = PLAN_QUOTA_DEFAULTS[plan].monthly;
      updates.daily_quota = PLAN_QUOTA_DEFAULTS[plan].daily;
    }

    const tenant = await db.updateTenant(id, updates);
    if (!tenant) {
      return res.status(404).json({ ok: false, code: 'NOT_FOUND', error: 'Tenant not found.' });
    }
    res.json({ ok: true, tenant, message: 'Tenant updated successfully.' });
  } catch (err) {
    res.status(500).json({ ok: false, code: 'TENANT_ACTIVATE_ERROR', error: err.message });
  }
});

router.get('/admin/messages', requireAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '50', 10);
    const offset = parseInt(req.query.offset || '0', 10);
    const tenantId = req.query.tenant_id || null;
    const status = req.query.status || null;
    const kind = req.query.kind || null;

    const messages = await db.listMessages({ tenantId, limit, offset, status, kind });
    res.json({ ok: true, count: messages.length, messages });
  } catch (err) {
    res.status(500).json({ ok: false, code: 'ADMIN_MESSAGES_ERROR', error: err.message });
  }
});

router.get('/admin/plan-requests', requireAdmin, async (req, res) => {
  try {
    const status = req.query.status || null;
    const requests = await db.listPlanRequests(status);
    res.json({ ok: true, count: requests.length, requests });
  } catch (err) {
    res.status(500).json({ ok: false, code: 'PLAN_REQUESTS_LIST_ERROR', error: err.message });
  }
});

router.post('/admin/plan-requests/:id/approve', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { plan_tier } = req.body || {};

    const updatedRequest = await db.updatePlanRequest(id, 'approved', req.adminEmail || 'Admin');
    if (!updatedRequest) {
      return res.status(404).json({ ok: false, code: 'NOT_FOUND', error: 'Request not found.' });
    }

    const tenant = await db.getTenantByEmail(updatedRequest.email);
    const plan = plan_tier || updatedRequest.requested_plan || 'starter';
    const quotas = PLAN_QUOTA_DEFAULTS[plan] || PLAN_QUOTA_DEFAULTS.starter;

    if (tenant) {
      await db.updateTenant(tenant.id, {
        is_active: true,
        plan_tier: plan,
        monthly_quota: quotas.monthly,
        daily_quota: quotas.daily
      });
    }

    res.json({
      ok: true,
      message: `Plan request approved for ${updatedRequest.email}. Tenant activated.`,
      request: updatedRequest
    });
  } catch (err) {
    res.status(500).json({ ok: false, code: 'PLAN_APPROVE_ERROR', error: err.message });
  }
});

router.post('/admin/plan-requests/:id/reject', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const updatedRequest = await db.updatePlanRequest(id, 'rejected', req.adminEmail || 'Admin');
    res.json({ ok: true, message: 'Request rejected.', request: updatedRequest });
  } catch (err) {
    res.status(500).json({ ok: false, code: 'PLAN_REJECT_ERROR', error: err.message });
  }
});

router.post('/admin/accounts/add', requireAdmin, async (req, res) => {
  try {
    const { account_index, label, daily_reminder_limit = 25 } = req.body || {};
    if (!account_index) {
      return res.status(400).json({ ok: false, code: 'INVALID_REQUEST', error: 'account_index is required.' });
    }

    const idx = parseInt(account_index, 10);
    const lineLabel = label || `SIM Liy ${idx}`;

    await db.createOrUpdateAccount({
      account_index: idx,
      label: lineLabel,
      daily_reminder_limit: parseInt(daily_reminder_limit, 10) || 25,
      is_enabled: true
    });

    const instance = await clusterManager.addAccount(idx, lineLabel);

    res.status(201).json({
      ok: true,
      message: `WhatsApp Line ${idx} added to cluster and initializing.`,
      account: {
        account_index: idx,
        label: lineLabel,
        status: instance.status || 'STANDBY'
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, code: 'ACCOUNT_ADD_ERROR', error: err.message });
  }
});

export default router;
