import express from 'express';
import { db } from '../database.js';
import { clusterManager } from '../whatsapp/cluster_manager.js';
import { authenticateApiKey, requireAdmin } from './middleware.js';
import { applySpintaxAndHashShield } from '../shield.js';
import { config } from '../config.js';

const router = express.Router();

// ==============================================================================
// 1. MESSAGES API (Protected by Tenant API Key)
// ==============================================================================

/**
 * POST /api/v1/messages/send
 * Body: { "to": "509XXXXXXXX", "message": "...", "kind": "receipt|welcome|otp|test|reminder|marketing", "pdf_base64": "...", "pdf_file_name": "Recu.pdf" }
 */
router.post('/messages/send', authenticateApiKey, async (req, res) => {
  try {
    const { to, message, kind = 'receipt', pdf_base64, pdf_file_name } = req.body;

    if (!to || !message) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required parameters: "to" and "message" are required.'
      });
    }

    // Clean phone number (strip spaces, symbols, pluses)
    const cleanedTo = to.toString().replace(/\D/g, '');
    if (cleanedTo.length < 8) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid phone number format. Must contain at least 8 digits.'
      });
    }

    const validKinds = ['receipt', 'welcome', 'otp', 'test', 'reminder', 'marketing'];
    const messageKind = validKinds.includes(kind) ? kind : 'receipt';
    const isFastLane = ['receipt', 'welcome', 'otp', 'test'].includes(messageKind);

    // Save message to Outbox queue
    const outboxMessage = await db.enqueueMessage({
      tenantId: req.tenant.id,
      toPhone: cleanedTo,
      message,
      pdfBase64: pdf_base64 || null,
      pdfFileName: pdf_file_name || null,
      kind: messageKind
    });

    res.status(202).json({
      ok: true,
      message_id: outboxMessage.id,
      status: 'queued',
      lane: isFastLane ? 'fast_lane' : 'slow_lane',
      kind: messageKind,
      recipient: cleanedTo,
      note: isFastLane 
        ? 'Message sent to Fast Lane for immediate organic delivery.' 
        : 'Message scheduled in Anti-Ban Slow Lane with organic 10-16 min pacing.'
    });
  } catch (err) {
    console.error('[API Send Message Error]:', err);
    res.status(500).json({ ok: false, error: err.message });
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
      return res.status(404).json({ ok: false, error: 'Message not found' });
    }

    // Enforce tenant isolation unless master admin
    if (msg.tenant_id !== req.tenant.id && !req.isAdmin) {
      return res.status(403).json({ ok: false, error: 'Access denied to this message.' });
    }

    res.json({
      ok: true,
      message: {
        id: msg.id,
        status: msg.status,
        kind: msg.kind,
        to_phone: msg.to_phone,
        assigned_account_index: msg.assigned_account_index,
        sent_by_phone: msg.sent_by_phone,
        retry_count: msg.retry_count,
        error_message: msg.error_message,
        created_at: msg.created_at,
        sent_at: msg.sent_at
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/v1/messages
 * List recent messages for tenant or admin
 */
router.get('/messages', authenticateApiKey, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '50', 10);
    const status = req.query.status || null;
    const kind = req.query.kind || null;

    const messages = await db.listMessages({
      tenantId: req.isAdmin ? null : req.tenant.id,
      limit,
      status,
      kind
    });

    res.json({ ok: true, count: messages.length, messages });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ==============================================================================
// 2. WHATSAPP ACCOUNTS CLUSTER MANAGEMENT
// ==============================================================================

/**
 * GET /api/v1/accounts
 * Return list of all WhatsApp lines in the cluster with live status
 */
router.get('/accounts', async (req, res) => {
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
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/v1/accounts/:index/qr
 * Returns QR Code data URL for scanning
 */
router.get('/accounts/:index/qr', async (req, res) => {
  try {
    const index = parseInt(req.params.index, 10);
    const dbAcc = await db.getAccountByIndex(index);
    const liveAcc = clusterManager.getAccount(index);

    if (!dbAcc && !liveAcc) {
      return res.status(404).json({ ok: false, error: `Account line ${index} not found.` });
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
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/v1/accounts/:index/reset
 * Wipes session files to allow client to scan a new WhatsApp phone number
 */
router.post('/accounts/:index/reset', async (req, res) => {
  try {
    const index = parseInt(req.params.index, 10);
    const result = await clusterManager.resetAccount(index);
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ==============================================================================
// 3. WEBHOOKS & SHIELD TOOLS
// ==============================================================================

/**
 * POST /api/v1/webhooks/register
 */
router.post('/webhooks/register', authenticateApiKey, async (req, res) => {
  try {
    const { url, events, secret } = req.body;
    if (!url) {
      return res.status(400).json({ ok: false, error: 'Webhook URL is required.' });
    }

    const webhook = await db.registerWebhook({
      tenantId: req.tenant.id,
      url,
      events: events || ['message.sent', 'message.failed'],
      secret
    });

    res.status(201).json({ ok: true, webhook });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/v1/shield/preview
 * Interactive preview tool to test Spintax and Zero-Width Hash transformations
 */
router.post('/shield/preview', (req, res) => {
  try {
    const { text, kind = 'receipt' } = req.body;
    if (!text) {
      return res.status(400).json({ ok: false, error: 'Text parameter is required.' });
    }

    const isReminder = ['reminder', 'marketing'].includes(kind);
    const result = applySpintaxAndHashShield(text, { forceEngagement: isReminder });

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
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ==============================================================================
// 4. SAAS AUTH SYNC & USER PROFILE
// ==============================================================================

/**
 * POST /api/v1/auth/sync
 * Syncs user after Supabase login, creates tenant or fetches existing, detects if admin
 */
router.post('/auth/sync', async (req, res) => {
  try {
    const { userId, email, companyName, requestedPlan } = req.body;

    if (!email) {
      return res.status(400).json({ ok: false, error: 'Email is required.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const isAdmin = config.adminEmails.includes(cleanEmail);

    let tenant = null;
    if (userId) {
      tenant = await db.getTenantByUserId(userId);
    }

    if (!tenant) {
      // Find by email or create new tenant record
      const allTenants = await db.listTenants();
      tenant = allTenants.find(t => t.email && t.email.toLowerCase() === cleanEmail);

      if (!tenant) {
        // Create new tenant (auto-activated if admin email)
        const plan = requestedPlan || (isAdmin ? 'enterprise' : 'starter');
        const quotas = {
          starter: { monthly: 300, daily: 15 },
          pro: { monthly: 3000, daily: 100 },
          enterprise: { monthly: 100000, daily: 5000 }
        }[plan] || { monthly: 300, daily: 15 };

        tenant = await db.createTenant({
          userId: userId || null,
          name: companyName || (isAdmin ? 'Admin Portal' : 'Nouvo Kliyan'),
          email: cleanEmail,
          planTier: plan,
          monthlyQuota: quotas.monthly,
          dailyQuota: quotas.daily,
          isActive: isAdmin // Admin is instantly active, clients require validation
        });

        // Also record a pending plan request if standard client
        if (!isAdmin) {
          await db.createPlanRequest({
            userId: userId || null,
            email: cleanEmail,
            companyName: companyName || 'Nouvo Kliyan',
            requestedPlan: plan
          });
        }
      }
    }

    res.json({
      ok: true,
      isAdmin,
      tenant
    });
  } catch (err) {
    console.error('[Auth Sync Error]:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/v1/plans/request
 * Standard user requests plan activation or plan change
 */
router.post('/plans/request', async (req, res) => {
  try {
    const { userId, email, companyName, requestedPlan, phoneNumber } = req.body;
    if (!email || !requestedPlan) {
      return res.status(400).json({ ok: false, error: 'Email and requestedPlan are required.' });
    }

    const request = await db.createPlanRequest({
      userId,
      email: email.trim().toLowerCase(),
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
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ==============================================================================
// 5. ADMIN CONTROL PANEL ENDPOINTS
// ==============================================================================

/**
 * GET /api/v1/admin/overview
 */
router.get('/admin/overview', requireAdmin, async (req, res) => {
  try {
    const tenants = await db.listTenants();
    const accounts = await db.listAccounts();
    const messages = await db.listMessages({ limit: 100 });
    const requests = await db.listPlanRequests('pending');

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
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/v1/admin/tenants
 */
router.get('/admin/tenants', requireAdmin, async (req, res) => {
  try {
    const tenants = await db.listTenants();
    res.json({ ok: true, count: tenants.length, tenants });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/v1/admin/tenants/:id/activate
 */
router.post('/admin/tenants/:id/activate', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { is_active = true, plan_tier } = req.body;

    const updates = { is_active: Boolean(is_active) };
    if (plan_tier) {
      updates.plan_tier = plan_tier;
      if (plan_tier === 'pro') {
        updates.monthly_quota = 3000;
        updates.daily_quota = 100;
      } else if (plan_tier === 'enterprise') {
        updates.monthly_quota = 100000;
        updates.daily_quota = 5000;
      } else {
        updates.monthly_quota = 300;
        updates.daily_quota = 15;
      }
    }

    const tenant = await db.updateTenant(id, updates);
    res.json({ ok: true, tenant, message: 'Tenant updated successfully.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/v1/admin/plan-requests
 */
router.get('/admin/plan-requests', requireAdmin, async (req, res) => {
  try {
    const status = req.query.status || null;
    const requests = await db.listPlanRequests(status);
    res.json({ ok: true, count: requests.length, requests });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/v1/admin/plan-requests/:id/approve
 * Approves a user request, activates or updates their tenant, assigns quota
 */
router.post('/admin/plan-requests/:id/approve', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { plan_tier } = req.body;

    const updatedRequest = await db.updatePlanRequest(id, 'approved', 'Admin');
    if (!updatedRequest) {
      return res.status(404).json({ ok: false, error: 'Request not found.' });
    }

    // Find and activate the tenant associated with this email
    const allTenants = await db.listTenants();
    const tenant = allTenants.find(t => t.email && t.email.toLowerCase() === updatedRequest.email.toLowerCase());

    const plan = plan_tier || updatedRequest.requested_plan || 'starter';
    const quotas = {
      starter: { monthly: 300, daily: 15 },
      pro: { monthly: 3000, daily: 100 },
      enterprise: { monthly: 100000, daily: 5000 }
    }[plan] || { monthly: 300, daily: 15 };

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
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/v1/admin/plan-requests/:id/reject
 */
router.post('/admin/plan-requests/:id/reject', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const updatedRequest = await db.updatePlanRequest(id, 'rejected', 'Admin');
    res.json({ ok: true, message: 'Request rejected.', request: updatedRequest });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/v1/admin/accounts/add
 * Add a new WhatsApp Line to the cluster
 */
router.post('/admin/accounts/add', requireAdmin, async (req, res) => {
  try {
    const { account_index, label, daily_reminder_limit = 25 } = req.body;
    if (!account_index) {
      return res.status(400).json({ ok: false, error: 'account_index is required.' });
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
        status: instance.status
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
