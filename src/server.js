import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import apiRoutes from './api/routes.js';
import securgymRoutes from './api/securgym_routes.js';
import { clusterManager } from './whatsapp/cluster_manager.js';
import { sessionStore } from './whatsapp/session_store.js';
import { securGymBridge } from './securgym/bridge_worker.js';

function getCgroupMemoryMb() {
  const candidates = ['/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory/memory.usage_in_bytes'];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const bytes = parseInt(fs.readFileSync(p, 'utf8').trim(), 10);
        if (Number.isFinite(bytes) && bytes > 0) {
          return Math.round(bytes / (1024 * 1024));
        }
      }
    } catch {}
  }
  return null;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, '../public');

export const app = express();

// Trust Render / Cloudflare reverse proxy for accurate req.ip without ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
app.set('trust proxy', 1);

// Security & Headers (permitting CDN scripts and inline styles for Lucide icons and UI)
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

app.use(cors());
if (!process.env.VERCEL) {
  app.use(morgan('short'));
}

// Support large payloads for PDF base64 uploads (up to 50MB)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// API Rate Limiting (240 requests per minute)
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 240,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many requests. Please slow down.' }
});

app.use('/api/', apiLimiter);

// Ultra-fast Health check endpoint (UptimeRobot keep-alive target — never blocks on Puppeteer)
app.get('/health', (req, res) => {
  const mem = process.memoryUsage();
  const accounts = clusterManager.getAllAccounts();
  res.json({
    ok: true,
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    environment: process.env.VERCEL ? 'vercel-serverless' : 'standalone-vps',
    service: 'CVISUAL WhatsApp Gateway Multi-Tenant',
    memoryMb: {
      rss: Math.round(mem.rss / (1024 * 1024)),
      heapUsed: Math.round(mem.heapUsed / (1024 * 1024)),
      heapTotal: Math.round(mem.heapTotal / (1024 * 1024)),
      containerTotal: getCgroupMemoryMb()
    },
    whatsapp: {
      maxConcurrentAccounts: config.maxConcurrentAccounts,
      readyAccounts: accounts.filter(a => a.isReady()).length,
      accounts: accounts.map(a => ({
        index: a.accountIndex,
        status: a.status,
        phone: a.phoneNumber || null
      }))
    },
    securgymBridge: securGymBridge.getStats()
  });
});

// Mount CVISUAL SaaS API first, then SecurGYM Cloud Gateway compatibility API
app.use('/api/v1', apiRoutes);
app.use('/api', securgymRoutes);

// Static assets (Landing page, Client Dashboard, Admin Portal)
app.use(express.static(publicDir));

// Fallback for SPA routing
app.get('*', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('[Unhandled Server Error]:', err);
  res.status(500).json({
    ok: false,
    error: err.message || 'Internal Server Error'
  });
});

// Standalone Server Startup (Skipped on Vercel serverless)
if (!process.env.VERCEL) {
  const server = app.listen(config.port, '0.0.0.0', async () => {
    console.log(`================================================================`);
    console.log(`🚀 CVISUAL STANDALONE MULTI-TENANT WHATSAPP GATEWAY & SAAS`);
    console.log(`📡 Server running on: http://0.0.0.0:${config.port}`);
    console.log(`⚙️  Environment: ${config.nodeEnv} | Node ${process.version}`);
    console.log(`⚡ Engine: Native Baileys Multi-Device (Zero-Chromium Low-RAM) | Max Lines: ${config.maxConcurrentAccounts}`);
    console.log(`🛡️  Shield: Spintax + Zero-Width Invisible Unicode Hash Active`);
    console.log(`⚡ Dual-Lane Engine: Fast Lane (Instant) & Slow Lane (10-16 min, 25/day)`);
    console.log(`🏋️  SecurGYM Cloud Bridge: ${securGymBridge.isEnabled() ? 'ACTIVE' : 'DISABLED'}`);
    console.log(`================================================================`);

    try {
      await clusterManager.initializeCluster();
      await securGymBridge.start();
    } catch (err) {
      console.error('[Cluster Startup Error]:', err.message);
    }
  });

  const shutdown = async (signal) => {
    console.log(`\n[System] Received ${signal}. Gracefully stopping WhatsApp Gateway...`);
    securGymBridge.stop();
    clusterManager.stop();

    const accounts = clusterManager.getAllAccounts();
    for (const acc of accounts) {
      try {
        if (acc.isReady()) {
          await sessionStore.backup(acc.accountIndex, acc.sessionPath).catch(() => {});
        }
        await acc.destroyBrowserOnly();
      } catch {}
    }

    server.close(() => {
      console.log('[System] HTTP server closed. Process terminated cleanly.');
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

export default app;
