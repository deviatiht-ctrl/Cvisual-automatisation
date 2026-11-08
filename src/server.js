import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import apiRoutes from './api/routes.js';
import { clusterManager } from './whatsapp/cluster_manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, '../public');

export const app = express();

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

// API Rate Limiting (120 requests per minute)
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many requests. Please slow down.' }
});

app.use('/api/', apiLimiter);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    environment: process.env.VERCEL ? 'vercel-serverless' : 'standalone-vps',
    service: 'CVISUAL WhatsApp Gateway Multi-Tenant'
  });
});

// Mount REST API
app.use('/api/v1', apiRoutes);

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
    console.log(`📡 Server running on: http://localhost:${config.port}`);
    console.log(`⚙️  Environment: ${config.nodeEnv}`);
    console.log(`🛡️  Shield: Spintax + Zero-Width Invisible Unicode Hash Active`);
    console.log(`⚡ Dual-Lane Engine: Fast Lane (Instant) & Slow Lane (10-16 min)`);
    console.log(`================================================================`);

    try {
      await clusterManager.initializeCluster();
    } catch (err) {
      console.error('[Cluster Startup Error]:', err.message);
    }
  });

  const shutdown = async (signal) => {
    console.log(`\n[System] Received ${signal}. Gracefully stopping WhatsApp Gateway...`);
    clusterManager.stop();

    const accounts = clusterManager.getAllAccounts();
    for (const acc of accounts) {
      try {
        if (acc.client) {
          await acc.client.destroy();
        }
      } catch (e) {
        // Ignore
      }
    }

    server.close(() => {
      console.log('[System] HTTP server closed. Process terminated cleanly.');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

export default app;
