import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

dotenv.config();

// Helper to find existing Chromium binary on the host
function resolveDefaultChromiumPath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  const commonPaths = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ];

  for (const p of commonPaths) {
    try {
      if (fs.existsSync(p)) {
        return p;
      }
    } catch (e) {
      // Ignore
    }
  }
  return null;
}

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'production',

  // Supabase Database & Auth (CVISUAL SaaS Control Plane + Session Backup Storage)
  supabase: {
    url: process.env.SUPABASE_URL || '',
    key: process.env.SUPABASE_KEY || '',
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || ''
  },

  // Admin Access Emails (strictly configured)
  adminEmails: (process.env.ADMIN_EMAILS || 'laurorejeanclarens0@gmail.com')
    .split(',')
    .map(email => email.trim().toLowerCase())
    .filter(Boolean),

  // Storage and WhatsApp Session Directory
  authDataDir: process.env.AUTH_DATA_DIR || path.resolve(process.cwd(), '.wwebjs_auth'),

  // Strict concurrency cap to respect 512Mi free-tier Render container memory
  maxConcurrentAccounts: Math.max(1, parseInt(process.env.MAX_CONCURRENT_ACCOUNTS || '1', 10)),

  // Cloud Session Backup in Supabase Storage (survives ephemeral container restarts)
  sessionBackup: {
    enabled: process.env.SESSION_BACKUP_ENABLED !== 'false',
    bucket: process.env.SESSION_BACKUP_BUCKET || 'cvisual-wa-sessions',
    intervalMs: parseInt(process.env.SESSION_BACKUP_INTERVAL_MS || '600000', 10)
  },

  // Optional SecurGYM Cloud Bridge Worker (driven strictly via environment variables)
  securgym: {
    enabled: process.env.SECURGYM_ENABLED === 'true',
    supabaseUrl: (process.env.SECURGYM_SUPABASE_URL || '').replace(/\/+$/, ''),
    supabaseKey: process.env.SECURGYM_SERVICE_ROLE_KEY || process.env.SECURGYM_SUPABASE_ANON_KEY || '',
    accountIndex: Math.max(1, parseInt(process.env.SECURGYM_CLOUD_ACCOUNT_INDEX || '1', 10)),
    defaultCountryCode: (process.env.SECURGYM_DEFAULT_COUNTRY_CODE || '509').replace(/\D/g, '') || '509',
    cronIntervalMs: parseInt(process.env.SECURGYM_CRON_INTERVAL_MS || String(60 * 60 * 1000), 10)
  },

  // Puppeteer Settings
  puppeteer: {
    executablePath: resolveDefaultChromiumPath(),
    headless: process.env.PUPPETEER_HEADLESS !== 'false'
  },

  // Anti-Ban & Dual-Lane Engine Tuning
  engine: {
    fastLane: {
      concurrency: parseInt(process.env.FAST_LANE_CONCURRENCY || '5', 10),
      minDelayMs: 3000,
      maxDelayMs: 9000,
      minTypingMs: 2000,
      maxTypingMs: 4000,
      dailyLimit: parseInt(process.env.MAX_TRANSACTIONAL_PER_DAY || '300', 10)
    },

    slowLane: {
      minIntervalMs: parseInt(process.env.SLOW_LANE_INTERVAL_MIN_MS || '600000', 10),
      maxJitterMs: parseInt(process.env.SLOW_LANE_JITTER_MAX_MS || '360000', 10),
      dailyReminderLimit: parseInt(process.env.MAX_REMINDERS_PER_DAY || '25', 10),
      batchPauseThreshold: parseInt(process.env.BATCH_PAUSE_EVERY_N || '5', 10),
      batchPauseDurationMs: parseInt(process.env.BATCH_PAUSE_MS || '600000', 10)
    }
  }
};
