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
    this.lastBackupAt = new Map();
    this.pendingTimers = new Map();
  }

  isEnabled() {
    return Boolean(config.sessionBackup?.enabled && db.isConfigured() && db.getSupabase());
  }

  getObjectKey(accountIndex) {
    return `baileys-account-${parseInt(accountIndex, 10)}.tar.gz`;
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
        let { error: createErr } = await supabase.storage.createBucket(bucketName, {
          public: false,
          fileSizeLimit: 45 * 1024 * 1024
        });
        if (createErr && !String(createErr.message || '').toLowerCase().includes('already exists')) {
          ({ error: createErr } = await supabase.storage.createBucket(bucketName, { public: false }));
        }
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
      const credsFile = path.join(sessionDir, 'creds.json');
      if (!fs.existsSync(credsFile)) return false;
      const raw = fs.readFileSync(credsFile, 'utf8');
      const parsed = JSON.parse(raw);
      return Boolean(parsed && parsed.registered === true && (parsed.me?.id || parsed.signedIdentityKey));
    } catch {
      return false;
    }
  }

  async listBackedUpIndices() {
    if (!this.isEnabled()) return new Set();
    try {
      const bucketOk = await this.ensureBucket();
      if (!bucketOk) return new Set();
      const supabase = db.getSupabase();
      const bucketName = config.sessionBackup.bucket || 'cvisual-wa-sessions';
      const { data, error } = await supabase.storage.from(bucketName).list('', { limit: 100 });
      if (error || !Array.isArray(data)) return new Set();

      const indices = new Set();
      for (const item of data) {
        const m = /^baileys-account-(\d+)\.tar\.gz$/.exec(String(item.name || ''));
        if (m) indices.add(parseInt(m[1], 10));
      }
      return indices;
    } catch {
      return new Set();
    }
  }

  async restore(accountIndex, sessionDir) {
    if (!this.isEnabled()) return false;
    const idx = parseInt(accountIndex, 10);

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
        console.log(`[SessionStore] No stored Baileys session yet for Line ${idx} — fresh QR ready.`);
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

      await execFileAsync('tar', ['-xzf', tmpTar, '-C', parentDir], { timeout: 20000 });

      if (!this.hasLocalSession(sessionDir)) {
        try {
          if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
        } catch {}
        return false;
      }

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

  scheduleBackup(accountIndex, sessionDir, delayMs = 6000) {
    if (!this.isEnabled()) return;
    const idx = parseInt(accountIndex, 10);
    const lastAt = this.lastBackupAt.get(idx) || 0;
    if (Date.now() - lastAt < 45000) return;

    if (this.pendingTimers.has(idx)) {
      clearTimeout(this.pendingTimers.get(idx));
    }
    const timer = setTimeout(() => {
      this.pendingTimers.delete(idx);
      this.backup(idx, sessionDir).catch(() => {});
    }, delayMs);
    this.pendingTimers.set(idx, timer);
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

      await execFileAsync(
        'tar',
        ['--warning=no-file-changed', '--ignore-failed-read', '--exclude=*.tmp', '-czf', tmpTar, '-C', parentDir, baseName],
        { timeout: 25000 }
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

      this.lastBackupAt.set(idx, Date.now());
      console.log(`[SessionStore] Backed up WhatsApp session for Line ${idx} (${(buffer.length / 1024).toFixed(1)} KB).`);
      return true;
    } catch (err) {
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
    const idx = parseInt(accountIndex, 10);
    if (this.pendingTimers.has(idx)) {
      clearTimeout(this.pendingTimers.get(idx));
      this.pendingTimers.delete(idx);
    }
    this.lastBackupAt.delete(idx);

    if (!this.isEnabled()) return false;
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
