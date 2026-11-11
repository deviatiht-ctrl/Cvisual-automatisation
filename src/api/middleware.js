import crypto from 'crypto';
import { db } from '../database.js';
import { config } from '../config.js';

function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb) && a === b;
}

export function extractBearerOrApiKey(req) {
  const authHeader = req.headers['authorization'] || req.headers['x-api-key'] || '';
  const trimmed = String(authHeader).trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase().startsWith('bearer ')) {
    return trimmed.slice(7).trim() || null;
  }
  return trimmed;
}

export function isAdminEmail(email) {
  if (!email) return false;
  return config.adminEmails.includes(String(email).trim().toLowerCase());
}

/**
 * Cryptographically verifies a CVISUAL Supabase Access Token JWT via Supabase Auth.
 */
export async function verifyCvisualSupabaseJwt(token) {
  if (!token || token.startsWith('cv_live_') || !db.isConfigured()) {
    return null;
  }
  try {
    const supabase = db.getSupabase();
    if (!supabase) return null;
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user?.email) {
      return null;
    }
    return data.user;
  } catch {
    return null;
  }
}

/**
 * Cryptographically verifies a SecurGYM Supabase Access Token JWT and confirms platform super-admin rights.
 */
export async function verifySecurgymSupabaseJwt(token) {
  if (
    !token ||
    token.startsWith('cv_live_') ||
    !config.securgym?.supabaseUrl ||
    !config.securgym?.supabaseKey
  ) {
    return null;
  }

  try {
    const userRes = await fetch(`${config.securgym.supabaseUrl}/auth/v1/user`, {
      method: 'GET',
      headers: {
        apikey: config.securgym.supabaseKey,
        Authorization: `Bearer ${token}`
      },
      signal: AbortSignal.timeout(6000)
    });

    if (!userRes.ok) return null;
    const user = await userRes.json();
    if (!user?.id || !user?.email) return null;

    if (isAdminEmail(user.email)) {
      return { user, isPlatformAdmin: true };
    }

    // Also allow any active super_admin in SecurGYM's staff table
    const staffUrl =
      `${config.securgym.supabaseUrl}/rest/v1/staff` +
      `?user_id=eq.${encodeURIComponent(user.id)}` +
      `&role=eq.super_admin&active=eq.true&deleted_at=is.null&select=id&limit=1`;

    const staffRes = await fetch(staffUrl, {
      method: 'GET',
      headers: {
        apikey: config.securgym.supabaseKey,
        Authorization: `Bearer ${token}`
      },
      signal: AbortSignal.timeout(6000)
    });

    if (staffRes.ok) {
      const rows = await staffRes.json();
      if (Array.isArray(rows) && rows.length > 0) {
        return { user, isPlatformAdmin: true };
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Middleware to authenticate Tenant API requests via API Key (Authorization: Bearer <API_KEY> or X-API-Key).
 */
export async function authenticateApiKey(req, res, next) {
  try {
    const apiKey = extractBearerOrApiKey(req);

    if (!apiKey) {
      return res.status(401).json({
        ok: false,
        code: 'MISSING_API_KEY',
        error: 'Authentication failed. Provide a valid API Key in Authorization: Bearer <API_KEY> or X-API-Key header.'
      });
    }

    const tenant = await db.getTenantByApiKey(apiKey);
    if (!tenant) {
      return res.status(401).json({
        ok: false,
        code: 'INVALID_API_KEY',
        error: 'Invalid API Key.'
      });
    }

    if (!tenant.is_active) {
      return res.status(403).json({
        ok: false,
        code: 'TENANT_INACTIVE',
        error: 'Account inactive or pending activation. Contact administrator.'
      });
    }

    req.tenant = tenant;
    req.isAdmin = Boolean(tenant.email && isAdminEmail(tenant.email));
    next();
  } catch (error) {
    console.error('[Auth Middleware Error]:', error);
    res.status(500).json({ ok: false, code: 'AUTH_ERROR', error: 'Internal authentication error' });
  }
}

/**
 * Hardened Admin authorization middleware.
 * Accepts ONLY:
 *  1) Timing-safe `x-admin-key` matching `ADMIN_API_SECRET` or `SUPABASE_SERVICE_ROLE_KEY`
 *  2) Active `cv_live_...` API Key belonging to an email in `ADMIN_EMAILS`
 *  3) Verified CVISUAL Supabase Auth JWT belonging to an email in `ADMIN_EMAILS`
 *  4) Verified SecurGYM Supabase Auth JWT belonging to `ADMIN_EMAILS` or `staff.role = 'super_admin'`
 */
export async function requireAdmin(req, res, next) {
  try {
    const adminSecret = String(req.headers['x-admin-key'] || '').trim();
    if (adminSecret) {
      const matchesConfiguredSecret =
        Boolean(config.adminApiSecret) && timingSafeEqualStr(adminSecret, config.adminApiSecret);
      const matchesServiceKey =
        Boolean(config.supabase.serviceRoleKey) &&
        timingSafeEqualStr(adminSecret, config.supabase.serviceRoleKey);

      if (matchesConfiguredSecret || matchesServiceKey) {
        req.isAdmin = true;
        req.adminEmail = config.adminEmails[0] || 'admin@cvisual.local';
        return next();
      }
    }

    const token = extractBearerOrApiKey(req);
    if (token) {
      if (token.startsWith('cv_live_')) {
        const tenant = await db.getTenantByApiKey(token);
        if (tenant && tenant.is_active && tenant.email && isAdminEmail(tenant.email)) {
          req.isAdmin = true;
          req.tenant = tenant;
          req.adminEmail = tenant.email.trim().toLowerCase();
          return next();
        }
      } else {
        const cvisualUser = await verifyCvisualSupabaseJwt(token);
        if (cvisualUser && isAdminEmail(cvisualUser.email)) {
          req.isAdmin = true;
          req.user = cvisualUser;
          req.adminEmail = cvisualUser.email.trim().toLowerCase();
          return next();
        }

        const securgymAdmin = await verifySecurgymSupabaseJwt(token);
        if (securgymAdmin?.isPlatformAdmin && securgymAdmin.user?.email) {
          req.isAdmin = true;
          req.user = securgymAdmin.user;
          req.adminEmail = securgymAdmin.user.email.trim().toLowerCase();
          return next();
        }
      }
    }

    return res.status(403).json({
      ok: false,
      code: 'ADMIN_FORBIDDEN',
      error: 'Access denied. Verified administrator authentication required.'
    });
  } catch (err) {
    console.error('[Admin Auth Error]:', err);
    res.status(500).json({ ok: false, code: 'ADMIN_AUTH_ERROR', error: 'Internal admin auth error' });
  }
}
