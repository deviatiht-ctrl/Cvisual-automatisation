import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  
  // Supabase Database & Auth
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
      maxDelayMs: 10000,
      minTypingMs: 2000,
      maxTypingMs: 4000
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
