import { createClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { config } from './config.js';

let supabaseClient = null;
const isSupabaseConfigured = Boolean(
  config.supabase.url && (config.supabase.serviceRoleKey || config.supabase.key)
);

if (isSupabaseConfigured) {
  supabaseClient = createClient(
    config.supabase.url,
    config.supabase.serviceRoleKey || config.supabase.key,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    }
  );
  console.log('[Database] Supabase client connected to project:', config.supabase.url);
} else {
  console.warn('[Database] Notice: Supabase URL or Key not set. Waiting for Supabase connection in .env.');
}

// In-memory cache & fallback (Prefixed with CVISUAL)
const memoryStore = {
  tenants: new Map(),
  accounts: new Map(),
  outbox: new Map(),
  planRequests: new Map(),
  webhooks: new Map()
};

function generateTenantApiKey(prefix = 'cv_live_') {
  return prefix + crypto.randomBytes(24).toString('hex');
}

// Seed official cluster lines
function initSeedAccounts() {
  if (memoryStore.accounts.size === 0) {
    memoryStore.accounts.set(1, {
      id: uuidv4(),
      account_index: 1,
      label: 'Liy Prensipal 1',
      phone_number: null,
      service_status: 'DISCONNECTED',
      qr_code_data_url: null,
      daily_reminder_limit: 25,
      sent_reminders_today: 0,
      sent_transactional_today: 0,
      last_sent_at: null,
      last_reminder_sent_at: null,
      consecutive_reminders_count: 0,
      restricted_until: null,
      is_enabled: true,
      created_at: new Date().toISOString()
    });

    memoryStore.accounts.set(2, {
      id: uuidv4(),
      account_index: 2,
      label: 'SIM Sekou 2',
      phone_number: null,
      service_status: 'DISCONNECTED',
      qr_code_data_url: null,
      daily_reminder_limit: 25,
      sent_reminders_today: 0,
      sent_transactional_today: 0,
      last_sent_at: null,
      last_reminder_sent_at: null,
      consecutive_reminders_count: 0,
      restricted_until: null,
      is_enabled: true,
      created_at: new Date().toISOString()
    });
  }

  // In-memory demo seed (only used when Supabase is not configured)
  if (!isSupabaseConfigured) {
    const adminApiKey = generateTenantApiKey('cv_live_admin_');
    const adminTenant = {
      id: 'cvisual-admin-tenant',
      user_id: null,
      name: 'CVISUAL Admin Command Center',
      email: 'laurorejeanclarens0@gmail.com',
      api_key: adminApiKey,
      plan_tier: 'enterprise',
      monthly_quota: 100000,
      daily_quota: 5000,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    memoryStore.tenants.set(adminTenant.id, adminTenant);

    const clientApiKey = generateTenantApiKey('cv_live_client_');
    const enterpriseClient = {
      id: 'cvisual-client-tenant-9',
      user_id: null,
      name: 'Entreprise Jean Clarens (Client Pro/Enterprise)',
      email: 'laurorejeanclarens9@gmail.com',
      api_key: clientApiKey,
      plan_tier: 'enterprise',
      monthly_quota: 100000,
      daily_quota: 5000,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    memoryStore.tenants.set(enterpriseClient.id, enterpriseClient);
  }
}

initSeedAccounts();

const OUTBOX_LIST_COLUMNS =
  'id, tenant_id, to_phone, message, pdf_file_name, kind, status, assigned_account_index, sent_by_phone, retry_count, error_message, created_at, sent_at';

export const db = {
  isConfigured() {
    return isSupabaseConfigured;
  },

  getSupabase() {
    return supabaseClient;
  },

  // ---------------- CVISUAL_TENANTS ----------------
  async getTenantByApiKey(apiKey) {
    if (!apiKey) return null;
    if (isSupabaseConfigured) {
      const { data, error } = await supabaseClient
        .from('cvisual_tenants')
        .select('*')
        .eq('api_key', apiKey)
        .maybeSingle();
      if (error) {
        console.error('[Database] getTenantByApiKey error:', error.message);
        return null;
      }
      return data;
    }

    for (const tenant of memoryStore.tenants.values()) {
      if (tenant.api_key === apiKey) return tenant;
    }
    return null;
  },

  async getTenantByUserId(userId) {
    if (!userId) return null;
    if (isSupabaseConfigured) {
      const { data, error } = await supabaseClient
        .from('cvisual_tenants')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: true })
        .limit(1);
      if (error) {
        console.error('[Database] getTenantByUserId error:', error.message);
        return null;
      }
      return Array.isArray(data) && data.length > 0 ? data[0] : null;
    }

    for (const tenant of memoryStore.tenants.values()) {
      if (tenant.user_id === userId) return tenant;
    }
    return null;
  },

  async getTenantByEmail(email) {
    if (!email) return null;
    const cleanEmail = email.trim().toLowerCase();
    if (isSupabaseConfigured) {
      const { data, error } = await supabaseClient
        .from('cvisual_tenants')
        .select('*')
        .eq('email', cleanEmail)
        .order('created_at', { ascending: true })
        .limit(1);
      if (error) {
        console.error('[Database] getTenantByEmail error:', error.message);
        return null;
      }
      return Array.isArray(data) && data.length > 0 ? data[0] : null;
    }

    for (const tenant of memoryStore.tenants.values()) {
      if (tenant.email && tenant.email.toLowerCase() === cleanEmail) {
        return tenant;
      }
    }
    return null;
  },

  async getTenantById(id) {
    if (!id) return null;
    if (isSupabaseConfigured) {
      const { data, error } = await supabaseClient
        .from('cvisual_tenants')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (error) return null;
      return data;
    }
    return memoryStore.tenants.get(id) || null;
  },

  async createTenant({
    userId = null,
    name,
    email = null,
    planTier = 'starter',
    monthlyQuota = 300,
    dailyQuota = 15,
    isActive = false
  }) {
    const apiKey = generateTenantApiKey();
    const cleanEmail = email && String(email).trim() ? String(email).trim().toLowerCase() : null;
    const nowIso = new Date().toISOString();
    const newTenant = {
      id: uuidv4(),
      user_id: userId || null,
      name: String(name || 'Nouvelle Intégration').trim(),
      email: cleanEmail,
      api_key: apiKey,
      plan_tier: planTier,
      monthly_quota: monthlyQuota,
      daily_quota: dailyQuota,
      is_active: Boolean(isActive),
      created_at: nowIso,
      updated_at: nowIso
    };

    if (isSupabaseConfigured) {
      const { data, error } = await supabaseClient
        .from('cvisual_tenants')
        .insert(newTenant)
        .select()
        .single();
      if (error) throw new Error(error.message);
      return data;
    }

    memoryStore.tenants.set(newTenant.id, newTenant);
    return newTenant;
  },

  async updateTenant(id, updates) {
    const patch = { ...updates, updated_at: new Date().toISOString() };
    if (isSupabaseConfigured) {
      const { data, error } = await supabaseClient
        .from('cvisual_tenants')
        .update(patch)
        .eq('id', id)
        .select()
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data;
    }
    const tenant = memoryStore.tenants.get(id);
    if (!tenant) return null;
    const updated = { ...tenant, ...patch };
    memoryStore.tenants.set(id, updated);
    return updated;
  },

  async rotateTenantApiKey(id) {
    const newApiKey = generateTenantApiKey();
    return await this.updateTenant(id, { api_key: newApiKey });
  },

  async deleteTenant(id) {
    if (!id) return false;
    if (isSupabaseConfigured) {
      const { error } = await supabaseClient
        .from('cvisual_tenants')
        .delete()
        .eq('id', id);
      if (error) throw new Error(error.message);
      return true;
    }
    const deleted = memoryStore.tenants.delete(id);
    if (deleted) {
      for (const [msgId, msg] of memoryStore.outbox.entries()) {
        if (msg.tenant_id === id) memoryStore.outbox.delete(msgId);
      }
      for (const [whId, wh] of memoryStore.webhooks.entries()) {
        if (wh.tenant_id === id) memoryStore.webhooks.delete(whId);
      }
    }
    return deleted;
  },

  async getOrEnsureAdminTenant(preferredEmail = null) {
    const candidates = [
      preferredEmail,
      ...config.adminEmails
    ]
      .filter(Boolean)
      .map(e => String(e).trim().toLowerCase());

    for (const email of candidates) {
      const found = await this.getTenantByEmail(email);
      if (found) {
        if (!found.is_active) {
          return await this.updateTenant(found.id, { is_active: true });
        }
        return found;
      }
    }

    const primaryEmail = candidates[0] || 'laurorejeanclarens0@gmail.com';
    return await this.createTenant({
      userId: null,
      name: 'CVISUAL Admin Command Center',
      email: primaryEmail,
      planTier: 'enterprise',
      monthlyQuota: 100000,
      dailyQuota: 5000,
      isActive: true
    });
  },

  async listTenants() {
    if (isSupabaseConfigured) {
      const { data, error } = await supabaseClient
        .from('cvisual_tenants')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw new Error(error.message);
      return data || [];
    }
    return Array.from(memoryStore.tenants.values()).sort(
      (a, b) => new Date(b.created_at) - new Date(a.created_at)
    );
  },

  // ---------------- USAGE & QUOTAS ----------------
  async getTenantUsageStats(tenantId) {
    const now = new Date();
    const dayStartIso = now.toISOString().slice(0, 10) + 'T00:00:00.000Z';
    const monthStartIso = now.toISOString().slice(0, 7) + '-01T00:00:00.000Z';
    const activeStatuses = ['sent', 'pending', 'processing'];

    if (isSupabaseConfigured) {
      const [
        { count: reservedToday },
        { count: sentToday },
        { count: reservedMonth },
        { count: sentMonth }
      ] = await Promise.all([
        supabaseClient
          .from('cvisual_messages_outbox')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', tenantId)
          .in('status', activeStatuses)
          .gte('created_at', dayStartIso),
        supabaseClient
          .from('cvisual_messages_outbox')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', tenantId)
          .eq('status', 'sent')
          .gte('created_at', dayStartIso),
        supabaseClient
          .from('cvisual_messages_outbox')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', tenantId)
          .in('status', activeStatuses)
          .gte('created_at', monthStartIso),
        supabaseClient
          .from('cvisual_messages_outbox')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', tenantId)
          .eq('status', 'sent')
          .gte('created_at', monthStartIso)
      ]);

      return {
        reserved_today: reservedToday || 0,
        sent_today: sentToday || 0,
        reserved_this_month: reservedMonth || 0,
        sent_this_month: sentMonth || 0
      };
    }

    const dayMs = new Date(dayStartIso).getTime();
    const monthMs = new Date(monthStartIso).getTime();
    let reservedToday = 0;
    let sentToday = 0;
    let reservedMonth = 0;
    let sentMonth = 0;

    for (const m of memoryStore.outbox.values()) {
      if (m.tenant_id !== tenantId) continue;
      const t = new Date(m.created_at).getTime();
      const isActive = activeStatuses.includes(m.status);
      if (t >= dayMs) {
        if (isActive) reservedToday++;
        if (m.status === 'sent') sentToday++;
      }
      if (t >= monthMs) {
        if (isActive) reservedMonth++;
        if (m.status === 'sent') sentMonth++;
      }
    }

    return {
      reserved_today: reservedToday,
      sent_today: sentToday,
      reserved_this_month: reservedMonth,
      sent_this_month: sentMonth
    };
  },

  async getUsageByTenantMap() {
    const now = new Date();
    const dayStartIso = now.toISOString().slice(0, 10) + 'T00:00:00.000Z';
    const monthStartIso = now.toISOString().slice(0, 7) + '-01T00:00:00.000Z';
    const dayMs = new Date(dayStartIso).getTime();
    const map = new Map();

    const bump = (tid, isToday, isSent) => {
      if (!tid) return;
      if (!map.has(tid)) {
        map.set(tid, { sent_today: 0, sent_this_month: 0, reserved_today: 0, reserved_this_month: 0 });
      }
      const entry = map.get(tid);
      entry.reserved_this_month++;
      if (isSent) entry.sent_this_month++;
      if (isToday) {
        entry.reserved_today++;
        if (isSent) entry.sent_today++;
      }
    };

    if (isSupabaseConfigured) {
      const { data, error } = await supabaseClient
        .from('cvisual_messages_outbox')
        .select('tenant_id, status, created_at')
        .in('status', ['sent', 'pending', 'processing'])
        .gte('created_at', monthStartIso)
        .limit(5000);
      if (!error && Array.isArray(data)) {
        for (const r of data) {
          const isToday = new Date(r.created_at).getTime() >= dayMs;
          bump(r.tenant_id, isToday, r.status === 'sent');
        }
      }
      return map;
    }

    const monthMs = new Date(monthStartIso).getTime();
    for (const m of memoryStore.outbox.values()) {
      if (!['sent', 'pending', 'processing'].includes(m.status)) continue;
      const t = new Date(m.created_at).getTime();
      if (t >= monthMs) {
        bump(m.tenant_id, t >= dayMs, m.status === 'sent');
      }
    }
    return map;
  },

  // ---------------- CVISUAL_PLAN_REQUESTS ----------------
  async createPlanRequest({ userId, email, companyName, requestedPlan, phoneNumber }) {
    const record = {
      id: uuidv4(),
      user_id: userId || null,
      email: email.trim().toLowerCase(),
      company_name: companyName,
      requested_plan: requestedPlan || 'starter',
      phone_number: phoneNumber || null,
      status: 'pending',
      created_at: new Date().toISOString()
    };

    if (isSupabaseConfigured) {
      const { data, error } = await supabaseClient
        .from('cvisual_plan_requests')
        .insert(record)
        .select()
        .single();
      if (error) throw new Error(error.message);
      return data;
    }
    memoryStore.planRequests.set(record.id, record);
    return record;
  },

  async listPlanRequests(status = null) {
    if (isSupabaseConfigured) {
      let query = supabaseClient
        .from('cvisual_plan_requests')
        .select('*')
        .order('created_at', { ascending: false });
      if (status) {
        query = query.eq('status', status);
      }
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      return data || [];
    }

    let items = Array.from(memoryStore.planRequests.values());
    if (status) {
      items = items.filter(req => req.status === status);
    }
    return items.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  },

  async updatePlanRequest(id, status, reviewedBy = 'Admin') {
    const patch = {
      status,
      reviewed_by: reviewedBy,
      reviewed_at: new Date().toISOString()
    };

    if (isSupabaseConfigured) {
      const { data, error } = await supabaseClient
        .from('cvisual_plan_requests')
        .update(patch)
        .eq('id', id)
        .select()
        .single();
      if (error) throw new Error(error.message);
      return data;
    }

    const item = memoryStore.planRequests.get(id);
    if (!item) return null;
    const updated = { ...item, ...patch };
    memoryStore.planRequests.set(id, updated);
    return updated;
  },

  // ---------------- CVISUAL_WHATSAPP_ACCOUNTS ----------------
  _getValidAccountColumns() {
    return new Set([
      'tenant_id',
      'account_index',
      'label',
      'phone_number',
      'service_status',
      'qr_code_data_url',
      'daily_reminder_limit',
      'sent_reminders_today',
      'sent_transactional_today',
      'last_sent_at',
      'last_reminder_sent_at',
      'consecutive_reminders_count',
      'restricted_until',
      'is_enabled'
    ]);
  },

  _filterAccountFields(fields = {}) {
    const allowed = this._getValidAccountColumns();
    const cleaned = {};
    for (const [k, v] of Object.entries(fields)) {
      if (allowed.has(k) && v !== undefined) {
        cleaned[k] = v;
      }
    }
    return cleaned;
  },

  _isPastUtcDay(isoTimestamp) {
    if (!isoTimestamp) return false;
    const d = new Date(isoTimestamp);
    if (Number.isNaN(d.getTime())) return false;
    const todayUtc = new Date().toISOString().slice(0, 10);
    return d.toISOString().slice(0, 10) < todayUtc;
  },

  async _resetAccountCountersIfNewDay(account) {
    if (!account) return account;
    const needsReset =
      (account.last_sent_at && this._isPastUtcDay(account.last_sent_at)) ||
      (account.last_reminder_sent_at && this._isPastUtcDay(account.last_reminder_sent_at));
    if (!needsReset) return account;
    if (
      (account.sent_reminders_today || 0) === 0 &&
      (account.sent_transactional_today || 0) === 0 &&
      (account.consecutive_reminders_count || 0) === 0
    ) {
      return account;
    }

    const resetPatch = {
      sent_reminders_today: 0,
      sent_transactional_today: 0,
      consecutive_reminders_count: 0
    };

    if (isSupabaseConfigured) {
      await supabaseClient
        .from('cvisual_whatsapp_accounts')
        .update(resetPatch)
        .eq('account_index', account.account_index);
    } else if (memoryStore.accounts.has(account.account_index)) {
      const memAcc = memoryStore.accounts.get(account.account_index);
      memoryStore.accounts.set(account.account_index, { ...memAcc, ...resetPatch });
    }
    return { ...account, ...resetPatch };
  },

  async listAccounts() {
    if (isSupabaseConfigured) {
      const { data, error } = await supabaseClient
        .from('cvisual_whatsapp_accounts')
        .select('*')
        .order('account_index', { ascending: true });
      if (error) throw new Error(error.message);
      const out = [];
      for (const acc of data || []) {
        out.push(await this._resetAccountCountersIfNewDay(acc));
      }
      return out;
    }
    const out = [];
    for (const acc of memoryStore.accounts.values()) {
      out.push(await this._resetAccountCountersIfNewDay(acc));
    }
    return out.sort((a, b) => a.account_index - b.account_index);
  },

  async getAccountByIndex(accountIndex) {
    const idx = parseInt(accountIndex, 10);
    if (isSupabaseConfigured) {
      const { data, error } = await supabaseClient
        .from('cvisual_whatsapp_accounts')
        .select('*')
        .eq('account_index', idx)
        .maybeSingle();
      if (error) return null;
      return await this._resetAccountCountersIfNewDay(data);
    }
    const mem = memoryStore.accounts.get(idx) || null;
    return await this._resetAccountCountersIfNewDay(mem);
  },

  async createOrUpdateAccount(accountData) {
    const idx = parseInt(accountData.account_index, 10);
    const payload = {
      ...this._filterAccountFields(accountData),
      account_index: idx
    };

    if (isSupabaseConfigured) {
      const { data, error } = await supabaseClient
        .from('cvisual_whatsapp_accounts')
        .upsert(payload, { onConflict: 'account_index' })
        .select()
        .single();
      if (error) throw new Error(error.message);
      return data;
    }

    const existing = memoryStore.accounts.get(idx) || {
      id: uuidv4(),
      created_at: new Date().toISOString()
    };
    const saved = { ...existing, ...payload };
    memoryStore.accounts.set(idx, saved);
    return saved;
  },

  async updateAccountStatus(accountIndex, serviceStatus, extraFields = {}) {
    const idx = parseInt(accountIndex, 10);
    if (extraFields.error_message) {
      console.warn(`[Database] Account ${idx} status=${serviceStatus}: ${extraFields.error_message}`);
    }
    const updates = {
      ...this._filterAccountFields(extraFields),
      service_status: serviceStatus
    };

    if (isSupabaseConfigured) {
      const { data, error } = await supabaseClient
        .from('cvisual_whatsapp_accounts')
        .update(updates)
        .eq('account_index', idx)
        .select()
        .maybeSingle();
      if (error) {
        console.error(`[Database] updateAccountStatus failed for index ${idx}:`, error.message);
        return null;
      }
      return data;
    }

    const account = memoryStore.accounts.get(idx);
    if (account) {
      const updated = { ...account, ...extraFields, service_status: serviceStatus };
      memoryStore.accounts.set(idx, updated);
      return updated;
    }
    return null;
  },

  async incrementAccountSent(accountIndex, isReminder = false) {
    const idx = parseInt(accountIndex, 10);
    const now = new Date().toISOString();

    if (isSupabaseConfigured) {
      const account = await this.getAccountByIndex(idx);
      if (!account) return;

      const updates = {
        last_sent_at: now
      };

      if (isReminder) {
        updates.sent_reminders_today = (account.sent_reminders_today || 0) + 1;
        updates.last_reminder_sent_at = now;
        updates.consecutive_reminders_count = (account.consecutive_reminders_count || 0) + 1;
      } else {
        updates.sent_transactional_today = (account.sent_transactional_today || 0) + 1;
      }

      await supabaseClient
        .from('cvisual_whatsapp_accounts')
        .update(updates)
        .eq('account_index', idx);
      return;
    }

    const account = await this.getAccountByIndex(idx);
    if (account) {
      account.last_sent_at = now;
      if (isReminder) {
        account.sent_reminders_today = (account.sent_reminders_today || 0) + 1;
        account.last_reminder_sent_at = now;
        account.consecutive_reminders_count = (account.consecutive_reminders_count || 0) + 1;
      } else {
        account.sent_transactional_today = (account.sent_transactional_today || 0) + 1;
      }
      memoryStore.accounts.set(idx, account);
    }
  },

  async resetConsecutiveReminders(accountIndex) {
    const idx = parseInt(accountIndex, 10);
    if (isSupabaseConfigured) {
      await supabaseClient
        .from('cvisual_whatsapp_accounts')
        .update({ consecutive_reminders_count: 0 })
        .eq('account_index', idx);
      return;
    }
    const acc = memoryStore.accounts.get(idx);
    if (acc) {
      acc.consecutive_reminders_count = 0;
      memoryStore.accounts.set(idx, acc);
    }
  },

  // ---------------- CVISUAL_MESSAGES_OUTBOX ----------------
  async enqueueMessage({
    tenantId,
    toPhone,
    message,
    pdfBase64 = null,
    pdfFileName = null,
    kind = 'receipt',
    status = 'pending',
    assignedAccountIndex = null,
    sentByPhone = null,
    sentAt = null
  }) {
    const item = {
      id: uuidv4(),
      tenant_id: tenantId,
      to_phone: toPhone,
      message,
      pdf_base64: pdfBase64,
      pdf_file_name: pdfFileName,
      kind,
      status,
      assigned_account_index: assignedAccountIndex,
      sent_by_phone: sentByPhone,
      retry_count: 0,
      error_message: null,
      created_at: new Date().toISOString(),
      sent_at: sentAt
    };

    if (isSupabaseConfigured) {
      const { data, error } = await supabaseClient
        .from('cvisual_messages_outbox')
        .insert(item)
        .select(OUTBOX_LIST_COLUMNS)
        .single();
      if (error) throw new Error(error.message);
      return { ...data, has_pdf: Boolean(data.pdf_file_name) };
    }

    memoryStore.outbox.set(item.id, item);
    return {
      ...item,
      pdf_base64: undefined,
      has_pdf: Boolean(item.pdf_file_name || item.pdf_base64)
    };
  },

  async getMessageById(id) {
    if (!id) return null;
    if (isSupabaseConfigured) {
      const { data, error } = await supabaseClient
        .from('cvisual_messages_outbox')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (error) return null;
      return data;
    }
    return memoryStore.outbox.get(id) || null;
  },

  async listMessages({ tenantId = null, limit = 50, offset = 0, status = null, kind = null } = {}) {
    const safeLimit = Math.max(1, Math.min(parseInt(limit, 10) || 50, 200));
    const safeOffset = Math.max(0, parseInt(offset, 10) || 0);

    if (isSupabaseConfigured) {
      let query = supabaseClient
        .from('cvisual_messages_outbox')
        .select(`${OUTBOX_LIST_COLUMNS}, cvisual_tenants(name)`)
        .order('created_at', { ascending: false })
        .range(safeOffset, safeOffset + safeLimit - 1);

      if (tenantId) query = query.eq('tenant_id', tenantId);
      if (status) query = query.eq('status', status);
      if (kind) query = query.eq('kind', kind);

      const { data, error } = await query;
      if (error) throw new Error(error.message);
      return (data || []).map(row => ({
        ...row,
        has_pdf: Boolean(row.pdf_file_name)
      }));
    }

    let items = Array.from(memoryStore.outbox.values());
    if (tenantId) items = items.filter(m => m.tenant_id === tenantId);
    if (status) items = items.filter(m => m.status === status);
    if (kind) items = items.filter(m => m.kind === kind);

    return items
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(safeOffset, safeOffset + safeLimit)
      .map(row => {
        const tenant = memoryStore.tenants.get(row.tenant_id);
        return {
          id: row.id,
          tenant_id: row.tenant_id,
          to_phone: row.to_phone,
          message: row.message,
          pdf_file_name: row.pdf_file_name,
          has_pdf: Boolean(row.pdf_file_name || row.pdf_base64),
          kind: row.kind,
          status: row.status,
          assigned_account_index: row.assigned_account_index,
          sent_by_phone: row.sent_by_phone,
          retry_count: row.retry_count,
          error_message: row.error_message,
          created_at: row.created_at,
          sent_at: row.sent_at,
          cvisual_tenants: tenant ? { name: tenant.name } : null
        };
      });
  },

  async fetchNextPendingFastLane() {
    const fastLaneKinds = ['receipt', 'welcome', 'otp', 'test', 'manual_direct'];
    if (isSupabaseConfigured) {
      const { data, error } = await supabaseClient
        .from('cvisual_messages_outbox')
        .select('*')
        .eq('status', 'pending')
        .in('kind', fastLaneKinds)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      if (error) return null;
      return data;
    }

    const sorted = Array.from(memoryStore.outbox.values())
      .filter(msg => msg.status === 'pending' && fastLaneKinds.includes(msg.kind))
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    return sorted[0] || null;
  },

  async fetchNextPendingSlowLane() {
    const slowLaneKinds = ['reminder', 'reminder_7d', 'reminder_2d', 'reminder_0d', 'reminder_expired', 'marketing', 'manual'];
    if (isSupabaseConfigured) {
      const { data, error } = await supabaseClient
        .from('cvisual_messages_outbox')
        .select('*')
        .eq('status', 'pending')
        .in('kind', slowLaneKinds)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      if (error) return null;
      return data;
    }

    const sorted = Array.from(memoryStore.outbox.values())
      .filter(msg => msg.status === 'pending' && slowLaneKinds.includes(msg.kind))
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    return sorted[0] || null;
  },

  async incrementMessageRetryOrFail(id, errorMessage, maxRetries = 5, forceFail = false) {
    const existing = await this.getMessageById(id);
    const nextRetry = forceFail ? maxRetries : (existing?.retry_count || 0) + 1;
    const status = nextRetry >= maxRetries ? 'failed' : 'pending';
    const updates = {
      status,
      retry_count: nextRetry,
      error_message: errorMessage
    };
    if (isSupabaseConfigured) {
      await supabaseClient
        .from('cvisual_messages_outbox')
        .update(updates)
        .eq('id', id);
      return { status, retryCount: nextRetry };
    }
    if (existing) {
      memoryStore.outbox.set(id, { ...existing, ...updates });
    }
    return { status, retryCount: nextRetry };
  },

  async updateMessageStatus(id, status, { assignedAccountIndex, sentByPhone, errorMessage, sentAt } = {}) {
    const updates = { status };
    if (assignedAccountIndex !== undefined) updates.assigned_account_index = assignedAccountIndex;
    if (sentByPhone !== undefined) updates.sent_by_phone = sentByPhone;
    if (errorMessage !== undefined) updates.error_message = errorMessage;
    if (sentAt !== undefined) updates.sent_at = sentAt;

    if (isSupabaseConfigured) {
      const { data, error } = await supabaseClient
        .from('cvisual_messages_outbox')
        .update(updates)
        .eq('id', id)
        .select(OUTBOX_LIST_COLUMNS)
        .maybeSingle();
      if (error) {
        console.error(`[Database] updateMessageStatus failed for ${id}:`, error.message);
        return null;
      }
      return data;
    }

    const msg = memoryStore.outbox.get(id);
    if (msg) {
      const updated = { ...msg, ...updates };
      memoryStore.outbox.set(id, updated);
      return updated;
    }
    return null;
  },

  async cancelPendingMessage(id, reason = 'Cancelled by API client') {
    const existing = await this.getMessageById(id);
    if (!existing) return { ok: false, reason: 'NOT_FOUND' };
    if (existing.status !== 'pending') {
      return { ok: false, reason: 'INVALID_STATE', currentStatus: existing.status };
    }
    const updated = await this.updateMessageStatus(id, 'cancelled', {
      errorMessage: reason
    });
    return { ok: true, message: updated };
  },

  async retryMessage(id) {
    const existing = await this.getMessageById(id);
    if (!existing) return { ok: false, reason: 'NOT_FOUND' };
    if (!['failed', 'cancelled', 'paused'].includes(existing.status)) {
      return { ok: false, reason: 'INVALID_STATE', currentStatus: existing.status };
    }
    const updates = {
      status: 'pending',
      retry_count: 0,
      error_message: null,
      assigned_account_index: null
    };
    if (isSupabaseConfigured) {
      const { data, error } = await supabaseClient
        .from('cvisual_messages_outbox')
        .update(updates)
        .eq('id', id)
        .select(OUTBOX_LIST_COLUMNS)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return { ok: true, message: data };
    }
    const updated = { ...existing, ...updates };
    memoryStore.outbox.set(id, updated);
    return { ok: true, message: updated };
  },

  // ---------------- CVISUAL_WEBHOOKS ----------------
  async registerWebhook({ tenantId, url, events = ['message.sent', 'message.failed'], secret = null }) {
    const webhook = {
      id: uuidv4(),
      tenant_id: tenantId,
      url,
      events,
      secret: secret || 'whsec_' + crypto.randomBytes(20).toString('hex'),
      created_at: new Date().toISOString()
    };

    if (isSupabaseConfigured) {
      const { data, error } = await supabaseClient
        .from('cvisual_webhooks')
        .insert(webhook)
        .select()
        .single();
      if (error) throw new Error(error.message);
      return data;
    }

    memoryStore.webhooks.set(webhook.id, webhook);
    return webhook;
  },

  async getWebhookById(id) {
    if (!id) return null;
    if (isSupabaseConfigured) {
      const { data, error } = await supabaseClient
        .from('cvisual_webhooks')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (error) return null;
      return data;
    }
    return memoryStore.webhooks.get(id) || null;
  },

  async deleteWebhook(id) {
    if (!id) return false;
    if (isSupabaseConfigured) {
      const { error } = await supabaseClient
        .from('cvisual_webhooks')
        .delete()
        .eq('id', id);
      if (error) throw new Error(error.message);
      return true;
    }
    return memoryStore.webhooks.delete(id);
  },

  async listWebhooks(tenantId) {
    if (isSupabaseConfigured) {
      const { data, error } = await supabaseClient
        .from('cvisual_webhooks')
        .select('*')
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false });
      if (error) throw new Error(error.message);
      return data || [];
    }

    return Array.from(memoryStore.webhooks.values())
      .filter(w => w.tenant_id === tenantId)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }
};
