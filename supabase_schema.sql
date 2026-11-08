-- ==============================================================================
-- CVISUAL AUTOMATISATION - DATABASE SCHEMA (AVÈK PREFIX CVISUAL_)
-- PostgreSQL / Supabase Compatible
-- Tout tab yo gen prefix "cvisual_" pou yo pa janm melanje ak lòt tab nan pwojè w la!
-- ==============================================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. TAB CVISUAL_TENANTS (Antrepriz oswa Aplikasyon Kliyan)
CREATE TABLE IF NOT EXISTS public.cvisual_tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255),
    api_key VARCHAR(128) UNIQUE NOT NULL,
    plan_tier VARCHAR(50) NOT NULL DEFAULT 'starter', -- starter, pro, enterprise
    monthly_quota INT NOT NULL DEFAULT 300,
    daily_quota INT NOT NULL DEFAULT 15,
    is_active BOOLEAN NOT NULL DEFAULT false, -- Admin dwe valide l anvan li aktif
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cvisual_tenants_api_key ON public.cvisual_tenants (api_key);
CREATE INDEX IF NOT EXISTS idx_cvisual_tenants_email ON public.cvisual_tenants (email);
CREATE INDEX IF NOT EXISTS idx_cvisual_tenants_user_id ON public.cvisual_tenants (user_id);

-- 2. TAB CVISUAL_WHATSAPP_ACCOUNTS (Liy WhatsApp ki nan Cluster a)
CREATE TABLE IF NOT EXISTS public.cvisual_whatsapp_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES public.cvisual_tenants(id) ON DELETE SET NULL,
    account_index INT UNIQUE NOT NULL, -- Nimewo liy lan (1, 2, 3...)
    label VARCHAR(100) NOT NULL, -- Egz: "Liy Prensipal", "SIM Sekou 1"
    phone_number VARCHAR(50),
    service_status VARCHAR(50) NOT NULL DEFAULT 'DISCONNECTED', -- DISCONNECTED, INITIALIZING, SCAN_QR, AUTHENTICATED, READY, RESTRICTED, ERROR
    qr_code_data_url TEXT, -- Imaj QR Code an Base64 Data URL
    daily_reminder_limit INT NOT NULL DEFAULT 25,
    sent_reminders_today INT NOT NULL DEFAULT 0,
    sent_transactional_today INT NOT NULL DEFAULT 0,
    last_sent_at TIMESTAMPTZ,
    last_reminder_sent_at TIMESTAMPTZ,
    consecutive_reminders_count INT NOT NULL DEFAULT 0,
    restricted_until TIMESTAMPTZ,
    is_enabled BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cvisual_wa_account_index ON public.cvisual_whatsapp_accounts (account_index);
CREATE INDEX IF NOT EXISTS idx_cvisual_wa_service_status ON public.cvisual_whatsapp_accounts (service_status);

-- 3. TAB CVISUAL_MESSAGES_OUTBOX (File d'attente tout mesaj k ap soti)
CREATE TABLE IF NOT EXISTS public.cvisual_messages_outbox (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES public.cvisual_tenants(id) ON DELETE CASCADE,
    to_phone VARCHAR(50) NOT NULL,
    message TEXT NOT NULL,
    pdf_base64 TEXT,
    pdf_file_name VARCHAR(255),
    kind VARCHAR(50) NOT NULL DEFAULT 'receipt', -- receipt, welcome, otp, test, reminder, marketing
    status VARCHAR(50) NOT NULL DEFAULT 'pending', -- pending, processing, sent, failed, paused
    assigned_account_index INT,
    sent_by_phone VARCHAR(50),
    retry_count INT NOT NULL DEFAULT 0,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_cvisual_outbox_status_kind ON public.cvisual_messages_outbox (status, kind);
CREATE INDEX IF NOT EXISTS idx_cvisual_outbox_tenant_id ON public.cvisual_messages_outbox (tenant_id);
CREATE INDEX IF NOT EXISTS idx_cvisual_outbox_created_at ON public.cvisual_messages_outbox (created_at);

-- 4. TAB CVISUAL_PLAN_REQUESTS (Demann Kliyan pou Enskripsyon oswa Chanjman Plan)
CREATE TABLE IF NOT EXISTS public.cvisual_plan_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    company_name VARCHAR(255) NOT NULL,
    requested_plan VARCHAR(50) NOT NULL DEFAULT 'starter', -- starter, pro, enterprise
    phone_number VARCHAR(50),
    status VARCHAR(50) NOT NULL DEFAULT 'pending', -- pending, approved, rejected
    reviewed_at TIMESTAMPTZ,
    reviewed_by VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cvisual_plan_requests_status ON public.cvisual_plan_requests (status);

-- 5. TAB CVISUAL_WEBHOOKS (Pou notifikasyon aplikasyon ekstèn)
CREATE TABLE IF NOT EXISTS public.cvisual_webhooks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES public.cvisual_tenants(id) ON DELETE CASCADE,
    url VARCHAR(500) NOT NULL,
    events TEXT[] DEFAULT ARRAY['message.sent', 'message.failed'],
    secret VARCHAR(128),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 6. FONKSYON POU RESETTE KONTÈ YO CHAK MINWI (Daily Counter Reset)
CREATE OR REPLACE FUNCTION public.cvisual_reset_daily_message_counters()
RETURNS void AS $$
BEGIN
    UPDATE public.cvisual_whatsapp_accounts
    SET sent_reminders_today = 0,
        sent_transactional_today = 0,
        consecutive_reminders_count = 0;
END;
$$ LANGUAGE plpgsql;

-- 7. RLS POLICIES (Sekirite Nivo Ranje)
ALTER TABLE public.cvisual_tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cvisual_whatsapp_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cvisual_messages_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cvisual_plan_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cvisual_webhooks ENABLE ROW LEVEL SECURITY;

-- Tenants: Kliyan ka li pwòp dosye pa yo
DROP POLICY IF EXISTS "Users can read own cvisual tenant" ON public.cvisual_tenants;
CREATE POLICY "Users can read own cvisual tenant"
    ON public.cvisual_tenants FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

-- Plan requests: Kliyan ka kreye e wè pwòp demann yo
DROP POLICY IF EXISTS "Users can read own cvisual requests" ON public.cvisual_plan_requests;
CREATE POLICY "Users can read own cvisual requests"
    ON public.cvisual_plan_requests FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own cvisual request" ON public.cvisual_plan_requests;
CREATE POLICY "Users can insert own cvisual request"
    ON public.cvisual_plan_requests FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = user_id);

-- Messages: Kliyan ka wè pwòp outbox yo
DROP POLICY IF EXISTS "Users can read own cvisual messages" ON public.cvisual_messages_outbox;
CREATE POLICY "Users can read own cvisual messages"
    ON public.cvisual_messages_outbox FOR SELECT
    TO authenticated
    USING (tenant_id IN (SELECT id FROM public.cvisual_tenants WHERE user_id = auth.uid()));

-- ==============================================================================
-- 8. DONE SEED OFISYÈL POU CVISUAL AUTOMATISATION
-- ==============================================================================

-- A. Liy WhatsApp Cluster
INSERT INTO public.cvisual_whatsapp_accounts (account_index, label, daily_reminder_limit)
VALUES 
    (1, 'Liy Prensipal 1', 25),
    (2, 'SIM Sekou 2', 25)
ON CONFLICT (account_index) DO NOTHING;

-- B. Seed Admin Tenant (laurorejeanclarens0@gmail.com)
INSERT INTO public.cvisual_tenants (name, email, api_key, plan_tier, monthly_quota, daily_quota, is_active)
VALUES (
    'CVISUAL Admin Command Center',
    'laurorejeanclarens0@gmail.com',
    'cv_live_admin_' || substr(md5(random()::text), 1, 24),
    'enterprise',
    100000,
    5000,
    true
)
ON CONFLICT (api_key) DO NOTHING;

-- C. Seed Enterprise Client ki Pran yon Plan (laurorejeanclarens9@gmail.com)
INSERT INTO public.cvisual_tenants (name, email, api_key, plan_tier, monthly_quota, daily_quota, is_active)
VALUES (
    'Entreprise Jean Clarens (Client Pro/Enterprise)',
    'laurorejeanclarens9@gmail.com',
    'cv_live_laurore9_' || substr(md5(random()::text), 1, 24),
    'enterprise',
    100000,
    5000,
    true
)
ON CONFLICT (api_key) DO NOTHING;
