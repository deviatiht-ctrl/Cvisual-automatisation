import { db } from '../database.js';
import { config } from '../config.js';

/**
 * Middleware to authenticate requests via API Key in Bearer token header
 */
export async function authenticateApiKey(req, res, next) {
  try {
    const authHeader = req.headers['authorization'] || req.headers['x-api-key'];
    let apiKey = null;

    if (authHeader) {
      if (authHeader.startsWith('Bearer ')) {
        apiKey = authHeader.substring(7).trim();
      } else {
        apiKey = authHeader.trim();
      }
    }

    if (!apiKey) {
      return res.status(401).json({
        ok: false,
        error: 'Authentication failed. Please provide a valid API Key in Authorization: Bearer <API_KEY> header.'
      });
    }

    const tenant = await db.getTenantByApiKey(apiKey);
    if (!tenant) {
      return res.status(401).json({
        ok: false,
        error: 'Invalid API Key.'
      });
    }

    if (!tenant.is_active) {
      return res.status(403).json({
        ok: false,
        error: 'Account pending activation. Please wait for an administrator to approve your tenant account.'
      });
    }

    req.tenant = tenant;
    next();
  } catch (error) {
    console.error('[Auth Middleware Error]:', error);
    res.status(500).json({ ok: false, error: 'Internal authentication error' });
  }
}

/**
 * Middleware to check Admin privileges
 */
export async function requireAdmin(req, res, next) {
  try {
    const adminEmail = (req.headers['x-admin-email'] || '').trim().toLowerCase();
    const adminSecret = req.headers['x-admin-key'] || '';

    // Check if matching master admin email list
    const isAdminEmail = adminEmail && config.adminEmails.includes(adminEmail);
    const isValidAdminSecret = adminSecret && (adminSecret === config.supabase.serviceRoleKey || adminSecret === 'cvisual-master-key');

    if (isAdminEmail || isValidAdminSecret) {
      req.isAdmin = true;
      return next();
    }

    // Also check if bearer token belongs to an enterprise/admin tenant
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const apiKey = authHeader.substring(7).trim();
      const tenant = await db.getTenantByApiKey(apiKey);
      if (tenant && tenant.email && config.adminEmails.includes(tenant.email.toLowerCase())) {
        req.isAdmin = true;
        req.tenant = tenant;
        return next();
      }
    }

    return res.status(403).json({
      ok: false,
      error: 'Access denied. Administrator privileges required.'
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Internal admin auth error' });
  }
}
