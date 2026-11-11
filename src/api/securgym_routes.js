import express from 'express';
import { config } from '../config.js';
import { clusterManager } from '../whatsapp/cluster_manager.js';
import { normalizePhoneDigits } from '../whatsapp/account_instance.js';
import { securGymBridge } from '../securgym/bridge_worker.js';

const router = express.Router();

const FAST_LANE_KINDS = new Set(['receipt', 'welcome', 'otp', 'test', 'manual_direct']);
const FORBIDDEN_REMINDER_REGEX =
  /Abonnement Expir[ée]|Dernier Jour|Ab[òo]nman Ekspire|D[èe]nye Jou|Membership Expired|Final Day/i;

const runtimeConfig = {
  validNumber: process.env.SECURGYM_VALID_NUMBER || '50932986751',
  backupNumber: '',
  defaultCountryCode: config.securgym?.defaultCountryCode || '509',
  autoSendWelcome: true,
  autoSendReceipts: true,
  autoSendReminders: true,
  reminderDaysBefore: 7
};

function getPrimaryIndex() {
  return config.securgym?.accountIndex || 1;
}

function formatClusterAccount(a) {
  return {
    id: `account_${a.accountIndex}`,
    account_index: a.accountIndex,
    index: a.accountIndex,
    label: a.label,
    service_status: a.status,
    status: a.status,
    phone_number: a.phoneNumber,
    phone: a.phoneNumber,
    push_name: a.pushName,
    pushName: a.pushName,
    qr_code: a.qrCodeDataUrl,
    qr: a.qrCodeDataUrl,
    rawQr: a.rawQrCode,
    sent_today: a.sentToday,
    sentToday: a.sentToday,
    daily_limit: securGymBridge.dailyReminderCap || config.engine.slowLane.dailyReminderLimit || 25,
    dailyLimit: securGymBridge.dailyReminderCap || config.engine.slowLane.dailyReminderLimit || 25,
    total_sent: 0,
    is_online: true,
    is_enabled: true,
    last_sent_at: a.lastSentAt ? new Date(a.lastSentAt).toISOString() : null,
    is_restricted: a.checkRestricted(),
    restricted_until: a.restrictedUntil,
    restriction_reason: a.restrictionReason,
    last_error: a.lastError
  };
}

// 1. Cluster status & primary line QR/connection info
router.get('/status', (req, res) => {
  const accounts = clusterManager.getAllAccounts();
  const readyCount = accounts.filter(a => a.isReady()).length;
  const readyAccount = accounts.find(a => a.isReady());
  const primary = clusterManager.getAccount(getPrimaryIndex()) || accounts[0] || null;
  const activeRep = readyAccount || primary;

  res.json({
    ok: true,
    status: readyCount > 0 ? 'READY' : (primary ? primary.status : 'INITIALIZING'),
    phone: activeRep ? activeRep.phoneNumber : null,
    pushname: activeRep ? activeRep.pushName : null,
    qr: activeRep ? activeRep.qrCodeDataUrl : null,
    rawQr: activeRep ? activeRep.rawQrCode : null,
    queueLength: securGymBridge.isEnabled() ? securGymBridge.lastQueueLength : 0,
    lastError: activeRep ? activeRep.lastError : null,
    cluster: {
      totalAccounts: accounts.length,
      readyAccounts: readyCount,
      accounts: accounts.map(a => ({
        index: a.accountIndex,
        label: a.label,
        status: a.status,
        phone: a.phoneNumber,
        pushName: a.pushName,
        sentToday: a.sentToday,
        dailyLimit: securGymBridge.dailyReminderCap || 25,
        isRestricted: a.checkRestricted(),
        restrictedUntil: a.restrictedUntil,
        hasQr: Boolean(a.qrCodeDataUrl)
      }))
    },
    securgym: securGymBridge.getStats(),
    config: runtimeConfig
  });
});

// 1bis. PNG QR endpoint (fallback used by Image.network in SecurGYM Settings)
router.get('/qr.png', (req, res) => {
  const acc = clusterManager.getAccount(getPrimaryIndex()) || clusterManager.getAllAccounts()[0];
  if (!acc || !acc.qrCodeDataUrl || !acc.qrCodeDataUrl.includes(',')) {
    return res.status(404).json({ ok: false, error: 'Aucun QR code disponible actuellement.' });
  }
  const base64Data = acc.qrCodeDataUrl.split(',')[1];
  const imgBuffer = Buffer.from(base64Data, 'base64');
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'no-store');
  res.send(imgBuffer);
});

// 2. List WhatsApp lines (merges remote SecurGYM cluster table with live Chromium instance)
router.get('/accounts', async (req, res) => {
  const liveAccounts = clusterManager.getAllAccounts();
  const liveByIdx = new Map(liveAccounts.map(a => [a.accountIndex, a]));

  if (securGymBridge.isEnabled()) {
    try {
      const dbRes = await securGymBridge._rest('platform_whatsapp_accounts?order=account_index.asc', {
        timeoutMs: 3000
      });
      if (dbRes.ok) {
        const dbRows = await dbRes.json();
        if (Array.isArray(dbRows) && dbRows.length > 0) {
          const merged = dbRows.map(row => {
            const live = liveByIdx.get(row.account_index);
            if (live) {
              return {
                ...row,
                ...formatClusterAccount(live),
                id: row.id || `account_${row.account_index}`,
                total_sent: row.total_sent || 0
              };
            }
            const cleanStatus = ['INITIALIZING', 'AUTHENTICATED', 'SCAN_QR'].includes(
              String(row.service_status || '').toUpperCase()
            )
              ? 'DISCONNECTED'
              : (row.service_status || 'DISCONNECTED');
            return {
              ...row,
              service_status: cleanStatus,
              status: cleanStatus,
              qr_code: null,
              is_online: false
            };
          });
          return res.json({ ok: true, accounts: merged });
        }
      }
    } catch {}
  }

  return res.json({ ok: true, accounts: liveAccounts.map(formatClusterAccount) });
});

// 3. Reconnect / Restart a specific line
router.post('/accounts/:index/initialize', async (req, res) => {
  const idx = parseInt(req.params.index, 10);
  const acc = clusterManager.getAccount(idx);

  if (!acc) {
    if (clusterManager.accounts.size >= config.maxConcurrentAccounts) {
      return res.status(409).json({
        ok: false,
        error: `Maksimòm ${config.maxConcurrentAccounts} liy ka aktif an menm tan sou sèvè Cloud la.`
      });
    }
    try {
      const inst = await clusterManager.registerAndStartAccount(idx, `Liy ${idx}`, { userTriggered: true });
      securGymBridge.attachAccountListeners(inst);
      setTimeout(() => securGymBridge.syncAndHeartbeat(), 500);
      return res.json({ ok: true, message: `Liy ${idx} ap demare sou sèvè Cloud la...` });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  try {
    securGymBridge.attachAccountListeners(acc);
    await clusterManager.restartAccount(idx, { awaitInit: false });
    setTimeout(() => securGymBridge.syncAndHeartbeat(), 500);
    return res.json({ ok: true, message: `Liy ${idx} ap rekonekte sou sèvè Cloud la...` });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// 4. Reset session (wipe auth + regenerate QR)
router.post('/accounts/:index/reset', async (req, res) => {
  const idx = parseInt(req.params.index, 10);
  const acc = clusterManager.getAccount(idx);
  if (!acc && clusterManager.accounts.size >= config.maxConcurrentAccounts) {
    return res.status(409).json({
      ok: false,
      error: `Maksimòm ${config.maxConcurrentAccounts} liy ka aktif an menm tan sou sèvè Cloud la.`
    });
  }

  try {
    await clusterManager.resetAccount(idx, { awaitInit: false });
    const inst = clusterManager.getAccount(idx);
    if (inst) securGymBridge.attachAccountListeners(inst);
    setTimeout(() => securGymBridge.syncAndHeartbeat(), 500);
    return res.json({ ok: true, message: `Sesyon Liy ${idx} efase nèt. Nouvo kòd QR ap prepare.` });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// 5. Unrestrict line
router.post('/accounts/:index/unrestrict', async (req, res) => {
  const idx = parseInt(req.params.index, 10);
  try {
    const acc = clusterManager.getAccount(idx);
    await securGymBridge.reportUnrestrict(idx);
    if (acc) {
      acc.restrictedUntil = null;
      acc.restrictionReason = null;
      acc.status = 'DISCONNECTED';
      acc.restart({ awaitInit: false }).catch(() => {});
    }
    setTimeout(() => securGymBridge.syncAndHeartbeat(), 500);
    return res.json({ ok: true, message: `Liy ${idx} debloke.` });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// 6. Interactive chats ("Agrandir WhatsApp")
router.get('/accounts/:index/chats', async (req, res) => {
  const idx = parseInt(req.params.index, 10);
  const acc = clusterManager.getAccount(idx);
  if (!acc) return res.status(404).json({ ok: false, error: `Liy ${idx} pa jwenn.` });
  if (!acc.isReady()) {
    return res.status(503).json({ ok: false, error: `Liy ${idx} poko konekte (Estati: ${acc.status}).` });
  }
  try {
    const chats = await acc.listChats(req.query.limit || 35);
    return res.json({ ok: true, chats });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/accounts/:index/chats/:chatId/messages', async (req, res) => {
  const idx = parseInt(req.params.index, 10);
  const acc = clusterManager.getAccount(idx);
  if (!acc) return res.status(404).json({ ok: false, error: `Liy ${idx} pa jwenn.` });
  if (!acc.isReady()) {
    return res.status(503).json({ ok: false, error: `Liy ${idx} poko konekte (Estati: ${acc.status}).` });
  }
  try {
    const messages = await acc.getChatMessages(decodeURIComponent(req.params.chatId), req.query.limit || 50);
    return res.json({ ok: true, messages });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.post(['/accounts/:index/chats/:chatId/send', '/accounts/:index/chats/send'], async (req, res) => {
  const idx = parseInt(req.params.index, 10);
  const acc = clusterManager.getAccount(idx);
  if (!acc) return res.status(404).json({ ok: false, error: `Liy ${idx} pa jwenn.` });
  if (!acc.isReady()) {
    return res.status(503).json({ ok: false, error: `Liy ${idx} poko konekte (Estati: ${acc.status}).` });
  }
  try {
    const chatId = req.params.chatId ? decodeURIComponent(req.params.chatId) : (req.body.chatId || '');
    const sent = await acc.sendDirectChatMessage(chatId, req.body.message || '');
    return res.json({ ok: true, message: sent });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// 7. Send message (Dual-Lane enforced)
router.post('/send', async (req, res) => {
  try {
    const {
      to,
      message,
      pdf_base64,
      pdfBase64,
      pdf_file_name,
      pdfFileName,
      kind = 'manual',
      gymId,
      gym_id
    } = req.body;

    if (!to || !message) {
      return res.status(400).json({ ok: false, error: 'Paramètres manquants: "to" et "message" requis.' });
    }

    const cleanPhone = normalizePhoneDigits(to, runtimeConfig.defaultCountryCode);
    if (!cleanPhone || cleanPhone.length < 8) {
      return res.status(400).json({ ok: false, error: 'Numéro destinataire invalide (minimum 8 chiffres).' });
    }

    const normalizedKind = String(kind || 'manual').toLowerCase().trim();
    const resolvedPdf = pdf_base64 || pdfBase64 || null;
    const resolvedPdfName = pdf_file_name || pdfFileName || null;

    // Auto-block J-0 / Expired patterns (never block explicit admin 'test' or 'otp')
    if (
      normalizedKind !== 'test' &&
      normalizedKind !== 'otp' &&
      (['reminder_0d', 'reminder_expired', 'reminder_due'].includes(normalizedKind) ||
        FORBIDDEN_REMINDER_REGEX.test(String(message)))
    ) {
      return res.status(422).json({
        ok: false,
        blocked: true,
        error: 'Bloqué par Anti-Ban : les messages J-0 / Abonnement Expiré automatiques sont désactivés.'
      });
    }

    if (FAST_LANE_KINDS.has(normalizedKind)) {
      const ready = clusterManager.getPrimaryReadyAccount();
      if (!ready) {
        return res.status(503).json({
          ok: false,
          error: 'Okenn liy WhatsApp pa pare oswa konekte kounye a sou sèvè Cloud la.'
        });
      }
      const result = await clusterManager.sendMessageAnywhere({
        to: cleanPhone,
        message,
        pdfBase64: resolvedPdf,
        pdfFileName: resolvedPdfName,
        kind: normalizedKind
      });
      return res.json({
        ok: true,
        lane: 'fast_lane',
        messageId: result.whatsappMessageId,
        to: result.to
      });
    }

    // Slow Lane MUST pass through Anti-Ban Queue (10-16 min spacing, max 25/day)
    const queued = await securGymBridge.enqueueOutbox({
      toPhone: cleanPhone,
      message,
      kind: normalizedKind,
      pdfBase64: resolvedPdf,
      pdfFileName: resolvedPdfName,
      gymId: gymId || gym_id || null
    });

    return res.status(202).json({
      ok: true,
      queued: true,
      lane: 'slow_lane',
      messageId: queued.id ? String(queued.id) : null,
      to: cleanPhone,
      note: 'Mesaj mete nan fil pwoteksyon Anti-Ban (10-16 minit, maksimòm 25 rapèl pa jou).'
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// 8. Immediate test message (always Fast Lane direct, surfaces exact status if not ready)
router.post(['/test', '/test-message'], async (req, res) => {
  try {
    const target = req.body.to || runtimeConfig.validNumber;
    const cleanPhone = normalizePhoneDigits(target, runtimeConfig.defaultCountryCode);
    if (!cleanPhone || cleanPhone.length < 8) {
      return res.status(400).json({ ok: false, error: 'Numéro destinataire de test invalide.' });
    }

    const ready = clusterManager.getPrimaryReadyAccount();
    if (!ready) {
      const primary = clusterManager.getAccount(getPrimaryIndex()) || clusterManager.getAllAccounts()[0];
      const st = primary ? primary.status : 'OFFLINE';
      return res.status(503).json({
        ok: false,
        status: st,
        error: `Liy WhatsApp la poko konekte (Estati: ${st}). Eskane kòd QR la nan seksyon Liy 1 anvan w teste.`
      });
    }

    const testMsg =
      req.body.message ||
      `🏋️ *SecurGYM Cloud Gateway*\nMesaj tès voye avèk siksè 24h/24 !\nDat: ${new Date().toLocaleString()}`;

    const result = await clusterManager.sendMessageAnywhere({
      to: cleanPhone,
      message: testMsg,
      kind: 'test'
    });

    return res.json({
      ok: true,
      message: 'Mesaj tès voye avèk siksè !',
      to: result.to,
      messageId: result.whatsappMessageId
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// 9. Expiration reminder cron trigger
router.post('/cron/check-expirations', async (req, res) => {
  try {
    const result = await securGymBridge.runCronExpirationReminders(req.body?.gymId || null);
    return res.json({ ok: true, result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// 10. Config endpoints
router.get('/config', (req, res) => {
  res.json({ ok: true, config: runtimeConfig });
});

router.post('/config', (req, res) => {
  const b = req.body || {};
  if (b.validNumber !== undefined) runtimeConfig.validNumber = String(b.validNumber).trim();
  if (b.backupNumber !== undefined) runtimeConfig.backupNumber = String(b.backupNumber).trim();
  if (b.defaultCountryCode !== undefined) {
    runtimeConfig.defaultCountryCode = String(b.defaultCountryCode).replace(/\D/g, '') || '509';
  }
  if (b.autoSendWelcome !== undefined) runtimeConfig.autoSendWelcome = Boolean(b.autoSendWelcome);
  if (b.autoSendReceipts !== undefined) runtimeConfig.autoSendReceipts = Boolean(b.autoSendReceipts);
  if (b.autoSendReminders !== undefined) runtimeConfig.autoSendReminders = Boolean(b.autoSendReminders);
  if (b.reminderDaysBefore !== undefined) {
    runtimeConfig.reminderDaysBefore = parseInt(b.reminderDaysBefore, 10) || 7;
  }
  res.json({ ok: true, config: runtimeConfig });
});

// 11. Legacy compatibility single-line endpoints
router.post('/initialize', async (req, res) => {
  const idx = getPrimaryIndex();
  try {
    await clusterManager.restartAccount(idx, { awaitInit: false });
    res.json({ ok: true, message: `Liy prensipal ${idx} ap rekonekte.` });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post(['/reset', '/logout', '/switch-account'], async (req, res) => {
  const idx = getPrimaryIndex();
  try {
    if (req.body?.backupNumber !== undefined) {
      runtimeConfig.backupNumber = String(req.body.backupNumber).trim();
    }
    if (req.body?.newNumber !== undefined && String(req.body.newNumber).trim()) {
      runtimeConfig.validNumber = String(req.body.newNumber).trim();
    }
    await clusterManager.resetAccount(idx, { awaitInit: false });
    res.json({ ok: true, message: `Sesyon Liy ${idx} reyinisyalize. Nouvo kòd QR ap prepare.` });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
