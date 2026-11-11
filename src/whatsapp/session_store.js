import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { db } from '../database.js';
import { config } from '../config.js';

const execFileAsync = promisify(execFile);

class SessionStore {
  constructor() {
    this.bucketReady = false;
    this.inFlightBackups = new Set();
  }

  isEnabled() {
    return Boolean(config.sessionBackup?.enabled && db.isConfigured() && db.getSupabase());
  }

  getObjectKey(accountIndex) {
    return `account-${parseInt(accountIndex, 10)}.tar.gz`;
  }

  async ensureBucket() {
    if (!this.isEnabled()) return false;
    if (this.bucketReady) return true;

    const supabase = db.getSupabase();
    const bucketName = config.sessionBackup.bucket || 'cvisual-wa-sessions';

    try {
      const { data: buckets, error: listErr } = await supabase.storage.listBuckets();
      if (listErr) {
        console.warn('[SessionStore] listBuckets error:', listErr.message);
        return false;
      }

      const exists = Array.isArray(buckets) && buckets.some(b => b.name === bucketName || b.id === bucketName);
      if (!exists) {
        const { error: createErr } = await supabase.storage.createBucket(bucketName, {
          public: false,
          fileSizeLimit: 104857600 // 100 MiB
        });
        if (createErr && !String(createErr.message || '').toLowerCase().includes('already exists')) {
          console.warn('[SessionStore] createBucket error:', createErr.message);
          return false;
        }
        console.log(`[SessionStore] Created private bucket "${bucketName}" for session persistence.`);
      }

      this.bucketReady = true;
      return true;
    } catch (err) {
      console.warn('[SessionStore] ensureBucket exception:', err.message);
      return false;
    }
  }

  hasLocalSession(sessionDir) {
    try {
      if (!sessionDir || !fs.existsSync(sessionDir)) return false;
      const defaultDir = path.join(sessionDir, 'Default');
      if (fs.existsSync(defaultDir)) {
        const entries = fs.readdirSync(defaultDir);
        return entries.length > 0;
      }
      const rootEntries = fs.readdirSync(sessionDir);
      return rootEntries.length > 0;
    } catch {
      return false;
    }
  }

  async restore(accountIndex, sessionDir) {
    if (!this.isEnabled()) return false;
    const idx = parseInt(accountIndex, 10);

    // If local directory already has session files (e.g. fast restart inside same container), keep it
    if (this.hasLocalSession(sessionDir)) {
      return true;
    }

    const bucketOk = await this.ensureBucket();
    if (!bucketOk) return false;

    const supabase = db.getSupabase();
    const bucketName = config.sessionBackup.bucket || 'cvisual-wa-sessions';
    const key = this.getObjectKey(idx);
    const tmpTar = path.join(os.tmpdir(), `wa-restore-${idx}-${Date.now()}.tar.gz`);

    try {
      const { data, error } = await supabase.storage.from(bucketName).download(key);
      if (error || !data) {
        if (error && !String(error.message || '').toLowerCase().includes('not found') && error.statusCode !== '404') {
          console.log(`[SessionStore] No stored session for Line ${idx} (${error.message || '404'})`);
        } else {
          console.log(`[SessionStore] No stored session backup yet for Line ${idx} — fresh QR will be generated.`);
        }
        return false;
      }

      const arrayBuf = await data.arrayBuffer();
      const buffer = Buffer.from(arrayBuf);
      if (buffer.length < 100) {
        return false;
      }

      const parentDir = path.dirname(sessionDir);
      fs.mkdirSync(parentDir, { recursive: true });
      fs.writeFileSync(tmpTar, buffer);

      await execFileAsync('tar', ['-xzf', tmpTar, '-C', parentDir], { timeout: 30000 });
      console.log(`[SessionStore] Restored WhatsApp session for Line ${idx} (${(buffer.length / 1024).toFixed(1)} KB).`);
      return true;
    } catch (err) {
      console.warn(`[SessionStore] Restore failed for Line ${idx}:`, err.message);
      return false;
    } finally {
      try {
        if (fs.existsSync(tmpTar)) fs.unlinkSync(tmpTar);
      } catch {}
    }
  }

  async backup(accountIndex, sessionDir) {
    if (!this.isEnabled()) return false;
    const idx = parseInt(accountIndex, 10);
    if (this.inFlightBackups.has(idx)) return false;
    if (!this.hasLocalSession(sessionDir)) return false;

    const bucketOk = await this.ensureBucket();
    if (!bucketOk) return false;

    this.inFlightBackups.add(idx);
    const supabase = db.getSupabase();
    const bucketName = config.sessionBackup.bucket || 'cvisual-wa-sessions';
    const key = this.getObjectKey(idx);
    const tmpTar = path.join(os.tmpdir(), `wa-backup-${idx}-${Date.now()}.tar.gz`);

    try {
      const parentDir = path.dirname(sessionDir);
      const baseName = path.basename(sessionDir);

      const excludeArgs = [
        '--exclude=Cache',
        '--exclude=Code Cache',
        '--exclude=GPUCache',
        '--exclude=DawnCache',
        '--exclude=DawnGraphiteCache',
        '--exclude=DawnWebGPUCache',
        '--exclude=ShaderCache',
        '--exclude=GrShaderCache',
        '--exclude=GraphiteDawnCache',
        '--exclude=CacheStorage',
        '--exclude=Crashpad',
        '--exclude=BrowserMetrics*',
        '--exclude=SingletonLock',
        '--exclude=SingletonCookie',
        '--exclude=SingletonSocket',
        '--exclude=DevToolsActivePort',
        '--exclude=lockfile',
        '--exclude=LOCK'
      ];

      await execFileAsync(
        'tar',
        ['--warning=no-file-changed', '--ignore-failed-read', '-czf', tmpTar, ...excludeArgs, '-C', parentDir, baseName],
        { timeout: 45000 }
      );

      const buffer = fs.readFileSync(tmpTar);
      if (!buffer || buffer.length < 100) {
        return false;
      }

      const { error } = await supabase.storage.from(bucketName).upload(key, buffer, {
        upsert: true,
        contentType: 'application/gzip'
      });

      if (error) {
        console.warn(`[SessionStore] Upload backup failed for Line ${idx}:`, error.message);
        return false;
      }

      console.log(`[SessionStore] Backed up WhatsApp session for Line ${idx} (${(buffer.length / (1024 * 1024)).toFixed(2)} MB).`);
      return true;
    } catch (err) {
      // tar exit code 1 happens sometimes if Chrome mutates a file mid-archive while already writing valid tar; ignore noise
      if (fs.existsSync(tmpTar) && fs.statSync(tmpTar).size > 1024 && Number(err.code) === 1) {
        try {
          const buffer = fs.readFileSync(tmpTar);
          const { error } = await supabase.storage.from(bucketName).upload(key, buffer, {
            upsert: true,
            contentType: 'application/gzip'
          });
          if (!error) {
            console.log(`[SessionStore] Backed up session (with code=1 warning) for Line ${idx} (${(buffer.length / (1024 * 1024)).toFixed(2)} MB).`);
            return true;
          }
        } catch {}
      }
      console.warn(`[SessionStore] Backup failed for Line ${idx}:`, err.message);
      return false;
    } finally {
      this.inFlightBackups.delete(idx);
      try {
        if (fs.existsSync(tmpTar)) fs.unlinkSync(tmpTar);
      } catch {}
    }
  }

  async remove(accountIndex) {
    if (!this.isEnabled()) return false;
    const idx = parseInt(accountIndex, 10);
    const bucketOk = await this.ensureBucket();
    if (!bucketOk) return false;

    try {
      const supabase = db.getSupabase();
      const bucketName = config.sessionBackup.bucket || 'cvisual-wa-sessions';
      const { error } = await supabase.storage.from(bucketName).remove([this.getObjectKey(idx)]);
      if (error) {
        console.warn(`[SessionStore] Remove backup error for Line ${idx}:`, error.message);
        return false;
      }
      console.log(`[SessionStore] Deleted cloud session backup for Line ${idx}.`);
      return true;
    } catch (err) {
      console.warn(`[SessionStore] Remove backup exception for Line ${idx}:`, err.message);
      return false;
    }
  }
}

export const sessionStore = new SessionStore();
