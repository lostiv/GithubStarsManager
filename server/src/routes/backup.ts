import { Router } from 'express';
import { getDb } from '../db/connection.js';
import { getBackupStatus, performAutoBackup, decryptBackupContent } from '../services/backupService.js';

const router = Router();

// GET /api/backup/settings
router.get('/api/backup/settings', (_req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT key, value FROM settings WHERE key LIKE ?').all(
      'auto_backup_%'
    ) as { key: string; value: string | null }[];

    const includeKeysRow = db.prepare("SELECT value FROM settings WHERE key = 'include_keys_in_backup'").get() as { value: string } | undefined;

    const settings: Record<string, unknown> = {
      auto_backup_enabled: false,
      auto_backup_interval_hours: 24,
      auto_backup_retention_count: 30,
      include_keys_in_backup: includeKeysRow?.value === 'true',
    };

    for (const row of rows) {
      if (row.key === 'auto_backup_enabled') {
        settings[row.key] = row.value === 'true';
      } else if (row.key === 'auto_backup_interval_hours' || row.key === 'auto_backup_retention_count') {
        settings[row.key] = row.value ? parseInt(row.value, 10) : settings[row.key];
      }
    }

    res.json(settings);
  } catch (err) {
    console.error('GET /api/backup/settings error:', err);
    res.status(500).json({ error: 'Failed to fetch backup settings', code: 'FETCH_BACKUP_SETTINGS_FAILED' });
  }
});

// PUT /api/backup/settings
router.put('/api/backup/settings', (req, res) => {
  try {
    const db = getDb();

    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      res.status(400).json({ error: '请求体格式无效', code: 'VALIDATION_FAILED' });
      return;
    }

    const { auto_backup_enabled, auto_backup_interval_hours, auto_backup_retention_count, include_keys_in_backup } = req.body as {
      auto_backup_enabled?: boolean;
      auto_backup_interval_hours?: number;
      auto_backup_retention_count?: number;
      include_keys_in_backup?: boolean;
    };

    const errors: string[] = [];

    if (auto_backup_enabled !== undefined && typeof auto_backup_enabled !== 'boolean') {
      errors.push('auto_backup_enabled 必须为布尔类型');
    }

    if (auto_backup_interval_hours !== undefined) {
      if (
        typeof auto_backup_interval_hours !== 'number' ||
        !Number.isFinite(auto_backup_interval_hours) ||
        !Number.isInteger(auto_backup_interval_hours) ||
        auto_backup_interval_hours < 1 ||
        auto_backup_interval_hours > 720
      ) {
        errors.push('备份间隔必须在 1-720 小时之间');
      }
    }

    if (auto_backup_retention_count !== undefined) {
      if (
        typeof auto_backup_retention_count !== 'number' ||
        !Number.isFinite(auto_backup_retention_count) ||
        !Number.isInteger(auto_backup_retention_count) ||
        auto_backup_retention_count < 0 ||
        auto_backup_retention_count > 365
      ) {
        errors.push('保留份数必须在 0-365 之间（0 表示不限制）');
      }
    }

    if (include_keys_in_backup !== undefined && typeof include_keys_in_backup !== 'boolean') {
      errors.push('include_keys_in_backup 必须为布尔类型');
    }

    if (auto_backup_enabled === true) {
      const activeConfig = db.prepare('SELECT id FROM webdav_configs WHERE is_active = 1').get();
      if (!activeConfig) {
        errors.push('启用自动备份前，请先在 WebDAV 设置中激活一个配置');
      }
    }

    if (errors.length > 0) {
      res.status(400).json({ error: errors.join('；'), code: 'VALIDATION_FAILED' });
      return;
    }

    const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');

    const upsert = db.transaction(() => {
      if (auto_backup_enabled !== undefined) {
        stmt.run('auto_backup_enabled', auto_backup_enabled ? 'true' : 'false');
      }
      if (auto_backup_interval_hours !== undefined) {
        stmt.run('auto_backup_interval_hours', String(auto_backup_interval_hours));
      }
      if (auto_backup_retention_count !== undefined) {
        stmt.run('auto_backup_retention_count', String(auto_backup_retention_count));
      }
      if (include_keys_in_backup !== undefined) {
        stmt.run('include_keys_in_backup', include_keys_in_backup ? 'true' : 'false');
      }
    });

    upsert();
    res.json({ updated: true });
  } catch (err) {
    console.error('PUT /api/backup/settings error:', err);
    res.status(500).json({ error: 'Failed to update backup settings', code: 'UPDATE_BACKUP_SETTINGS_FAILED' });
  }
});

// GET /api/backup/status
router.get('/api/backup/status', (_req, res) => {
  try {
    const status = getBackupStatus();
    res.json(status);
  } catch (err) {
    console.error('GET /api/backup/status error:', err);
    res.status(500).json({ error: 'Failed to fetch backup status', code: 'FETCH_BACKUP_STATUS_FAILED' });
  }
});

// POST /api/backup/trigger
router.post('/api/backup/trigger', async (_req, res) => {
  try {
    const result = await performAutoBackup();
    res.json(result);
  } catch (err) {
    console.error('POST /api/backup/trigger error:', err);
    res.status(500).json({ success: false, message: '触发备份失败', error: 'TRIGGER_BACKUP_FAILED' });
  }
});

// POST /api/backup/decrypt
router.post('/api/backup/decrypt', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      res.status(400).json({ error: '请求体格式无效', code: 'VALIDATION_FAILED' });
      return;
    }
    const { content } = req.body as { content?: string };
    if (!content || typeof content !== 'string') {
      res.status(400).json({ error: '缺少备份文件内容', code: 'VALIDATION_FAILED' });
      return;
    }
    const decrypted = decryptBackupContent(content);
    res.json(JSON.parse(decrypted));
  } catch (err) {
    console.error('POST /api/backup/decrypt error:', err);
    res.status(400).json({
      error: err instanceof Error ? err.message : '解密失败',
      code: 'DECRYPT_BACKUP_FAILED',
    });
  }
});

export default router;
