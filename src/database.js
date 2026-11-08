import { createClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { config } from './config.js';

let supabaseClient = null;
const isSupabaseConfigured = Boolean(config.supabase.url && (config.supabase.serviceRoleKey || config.supabase.key));

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

  // Seed Admin tenant (laurorejeanclarens0@gmail.com)
  const adminApiKey = 'cv_live_admin_' + crypto.randomBytes(16).toString('hex');
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
    created_at: new Date().toISOString()
  };
  memoryStore.tenants.set(adminTenant.id, adminTenant);

  // Seed Enterprise Client tenant (laurorejeanclarens9@gmail.com)
  const clientApiKey = 'cv_live_client_' + crypto.randomBytes(16).toString('hex');
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
    created_at: new Date().toISOString()
  };
  memoryStore.tenants.set(enterpriseClient.id, enterpriseClient);

  console.log(`[Database Seed] Admin Tenant: laurorejeanclarens0@gmail.com (API Key: ${adminApiKey})`);
  console.log(`[Database Seed] Enterprise Client: laurorejeanclarens9@gmail.com (API Key: ${clientApiKey})`);
}

initSeedAccounts();

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
        .maybeSingle();
      if (error) {
        console.error('[Database] getTenantByUserId error:', error.message);
        return null;
      }
      return data;
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
        .maybeSingle();
      if (error) return null;
      return data;
    }

    for (const tenant of memoryStore.tenants.values()) {
      if (tenant.email && tenant.email.toLowerCase() === cleanEmail) {
        return tenant;
      }
    }
    return null;
  },

  async getTenantById(id) {
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

  async createTenant({ userId, name, email, planTier = 'starter', monthlyQuota = 300, dailyQuota = 15, isActive = false }) {
    const apiKey = 'cv_live_' + crypto.randomBytes(24).toString('hex');
    const newTenant = {
      id: uuidv4(),
      user_id: userId || null,
      name,
      email: email ? email.trim().toLowerCase() : '',
      api_key: apiKey,
      plan_tier: planTier,
      monthly_quota: monthlyQuota,
      daily_quota: dailyQuota,
      is_active: isActive,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
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
    updates.updated_at = new Date().toISOString();
    if (isSupabaseConfigured) {
      const { data, error } = await supabaseClient
        .from('cvisual_tenants')
        .update(updates)
        .eq('id', id)
        .select()
        .single();
      if (error) throw new Error(error.message);
      return data;
    }
    const tenant = memoryStore.tenants.get(id);
    if (!tenant) return null;
    const updated = { ...tenant, ...updates };
    memoryStore.tenants.set(id, updated);
    return updated;
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
  async listAccounts() {
    if (isSupabaseConfigured) {
      const { data, error } = await supabaseClient
        .from('cvisual_whatsapp_accounts')
        .select('*')
        .order('account_index', { ascending: true });
      if (error) throw new Error(error.message);
      return data || [];
    }
    return Array.from(memoryStore.accounts.values()).sort(
      (a, b) => a.account_index - b.account_index
    );
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
      return data;
    }
    return memoryStore.accounts.get(idx) || null;
  },

  async createOrUpdateAccount(accountData) {
    const idx = parseInt(accountData.account_index, 10);
    const payload = {
      ...accountData,
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

    const existing = memoryStore.accounts.get(idx) || { id: uuidv4(), created_at: new Date().toISOString() };
    const saved = { ...existing, ...payload };
    memoryStore.accounts.set(idx, saved);
    return saved;
  },

  async updateAccountStatus(accountIndex, serviceStatus, extraFields = {}) {
    const idx = parseInt(accountIndex, 10);
    const updates = {
      service_status: serviceStatus,
      ...extraFields
    };

    if (isSupabaseConfigured) {
      const { data, error } = await supabaseClient
        .from('cvisual_whatsapp_accounts')
        .update(updates)
        .eq('account_index', idx)
        .select()
        .single();
      if (error) {
        console.error(`[Database] updateAccountStatus failed for index ${idx}:`, error.message);
        return null;
      }
      return data;
    }

    const account = memoryStore.accounts.get(idx);
    if (account) {
      const updated = { ...account, ...updates };
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

    const account = memoryStore.accounts.get(idx);
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
  async enqueueMessage({ tenantId, toPhone, message, pdfBase64 = null, pdfFileName = null, kind = 'receipt' }) {
    const item = {
      id: uuidv4(),
      tenant_id: tenantId,
      to_phone: toPhone,
      message,
      pdf_base64: pdfBase64,
      pdf_file_name: pdfFileName,
      kind,
      status: 'pending',
      assigned_account_index: null,
      sent_by_phone: null,
      retry_count: 0,
      error_message: null,
      created_at: new Date().toISOString(),
      sent_at: null
    };

    if (isSupabaseConfigured) {
      const { data, error } = await supabaseClient
        .from('cvisual_messages_outbox')
        .insert(item)
        .select()
        .single();
      if (error) throw new Error(error.message);
      return data;
    }

    memoryStore.outbox.set(item.id, item);
    return item;
  },

  async getMessageById(id) {
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

  async listMessages({ tenantId = null, limit = 50, status = null, kind = null } = {}) {
    if (isSupabaseConfigured) {
      let query = supabaseClient
        .from('cvisual_messages_outbox')
        .select('*, cvisual_tenants(name)')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (tenantId) query = query.eq('tenant_id', tenantId);
      if (status) query = query.eq('status', status);
      if (kind) query = query.eq('kind', kind);

      const { data, error } = await query;
      if (error) throw new Error(error.message);
      return data || [];
    }

    let items = Array.from(memoryStore.outbox.values());
    if (tenantId) items = items.filter(m => m.tenant_id === tenantId);
    if (status) items = items.filter(m => m.status === status);
    if (kind) items = items.filter(m => m.kind === kind);

    return items
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, limit);
  },

  async fetchNextPendingFastLane() {
    const fastLaneKinds = ['receipt', 'welcome', 'otp', 'test'];
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

    for (const msg of memoryStore.outbox.values()) {
      if (msg.status === 'pending' && fastLaneKinds.includes(msg.kind)) {
        return msg;
      }
    }
    return null;
  },

  async fetchNextPendingSlowLane() {
    const slowLaneKinds = ['reminder', 'marketing'];
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

    for (const msg of memoryStore.outbox.values()) {
      if (msg.status === 'pending' && slowLaneKinds.includes(msg.kind)) {
        return msg;
      }
    }
    return null;
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
        .select()
        .single();
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

  // ---------------- CVISUAL_WEBHOOKS ----------------
  async registerWebhook({ tenantId, url, events = ['message.sent', 'message.failed'], secret = null }) {
    const webhook = {
      id: uuidv4(),
      tenant_id: tenantId,
      url,
      events,
      secret: secret || crypto.randomBytes(16).toString('hex'),
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

  async listWebhooks(tenantId) {
    if (isSupabaseConfigured) {
      const { data, error } = await supabaseClient
        .from('cvisual_webhooks')
        .select('*')
        .eq('tenant_id', tenantId);
      if (error) throw new Error(error.message);
      return data || [];
    }

    return Array.from(memoryStore.webhooks.values()).filter(w => w.tenant_id === tenantId);
  }
};
