import { Router } from 'express';
import { getDb } from '../db/connection.js';
import { getAutoSyncStatus } from '../services/autoSyncService.js';

const router = Router();

const DEFAULT_SETTINGS = {
  auto_sync_enabled_repos: false,
  auto_sync_enabled_forks: false,
  auto_sync_enabled_releases: false,
  auto_sync_interval_minutes: 1440,
};

// GET /api/auto-sync/settings
router.get('/api/auto-sync/settings', (_req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'auto_sync_%'").all() as Array<{ key: string; value: string }>;
    const settings: Record<string, unknown> = { ...DEFAULT_SETTINGS };

    for (const row of rows) {
      if (row.key in DEFAULT_SETTINGS) {
        if (typeof DEFAULT_SETTINGS[row.key as keyof typeof DEFAULT_SETTINGS] === 'boolean') {
          settings[row.key] = row.value === 'true';
        } else if (typeof DEFAULT_SETTINGS[row.key as keyof typeof DEFAULT_SETTINGS] === 'number') {
          settings[row.key] = parseInt(row.value, 10) || (DEFAULT_SETTINGS[row.key as keyof typeof DEFAULT_SETTINGS] as number);
        } else {
          settings[row.key] = row.value;
        }
      }
    }

    res.json(settings);
  } catch (err) {
    console.error('GET /api/auto-sync/settings error:', err);
    res.status(500).json({ error: 'Failed to fetch auto-sync settings' });
  }
});

// PUT /api/auto-sync/settings
router.put('/api/auto-sync/settings', (req, res) => {
  try {
    const db = getDb();
    const body = req.body as Record<string, unknown>;

    // Validate boolean fields
    const boolFields = ['auto_sync_enabled_repos', 'auto_sync_enabled_forks', 'auto_sync_enabled_releases'];
    for (const field of boolFields) {
      if (field in body && typeof body[field] !== 'boolean') {
        res.status(400).json({ error: `${field} must be a boolean`, code: 'INVALID_BOOLEAN' });
        return;
      }
    }

    // Validate interval
    if ('auto_sync_interval_minutes' in body) {
      const val = body.auto_sync_interval_minutes;
      if (typeof val !== 'number' || !Number.isInteger(val) || val < 1 || val > 43200) {
        res.status(400).json({ error: 'auto_sync_interval_minutes must be an integer between 1 and 43200', code: 'INVALID_INTERVAL' });
        return;
      }
    }

    // If enabling any sync type, verify github_token exists
    const anyEnabled = (body.auto_sync_enabled_repos === true) ||
      (body.auto_sync_enabled_forks === true) ||
      (body.auto_sync_enabled_releases === true);
    if (anyEnabled) {
      const tokenRow = db.prepare("SELECT value FROM settings WHERE key = 'github_token'").get() as { value: string } | undefined;
      if (!tokenRow?.value) {
        res.status(400).json({ error: 'GitHub token not configured. Please set up your GitHub token first.', code: 'GITHUB_TOKEN_NOT_CONFIGURED' });
        return;
      }
    }

    const upsert = db.transaction(() => {
      for (const [key, value] of Object.entries(body)) {
        if (key in DEFAULT_SETTINGS) {
          db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
        }
      }
    });

    upsert();
    res.json({ updated: true });
  } catch (err) {
    console.error('PUT /api/auto-sync/settings error:', err);
    res.status(500).json({ error: 'Failed to update auto-sync settings' });
  }
});

// GET /api/auto-sync/status
router.get('/api/auto-sync/status', (_req, res) => {
  try {
    const status = getAutoSyncStatus();
    res.json(status);
  } catch (err) {
    console.error('GET /api/auto-sync/status error:', err);
    res.status(500).json({ error: 'Failed to fetch auto-sync status' });
  }
});

export default router;
