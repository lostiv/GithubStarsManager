import { Router } from 'express';
import { getDb } from '../db/connection.js';
import { refreshForksFromGitHub } from '../services/forkService.js';

const router = Router();

// ── Helpers ──

function dbRowToFork(row: Record<string, unknown>) {
  const owner = JSON.parse((row.owner as string) || '{}');
  const source = row.source ? JSON.parse(row.source as string) : null;
  const parent = row.parent ? JSON.parse(row.parent as string) : null;

  return {
    id: row.id,
    name: row.name,
    fork: true,
    full_name: row.full_name,
    description: row.description,
    html_url: row.html_url,
    stargazers_count: row.stargazers_count,
    forks_count: row.forks_count,
    forks: row.forks,
    language: row.language,
    created_at: row.created_at,
    updated_at: row.updated_at,
    pushed_at: row.pushed_at,
    default_branch: row.default_branch,
    owner,
    source,
    ...(parent ? { parent } : {}),
    has_unread: row.is_read === 0,
    upstream_updated_at: row.upstream_pushed_at ?? undefined,
    fetched_at: row.fetched_at ?? undefined,
  };
}

// ── GET /api/forks — return cached forks from DB ──
router.get('/api/forks', (_req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM forks ORDER BY id DESC').all() as Record<string, unknown>[];
    const forks = rows.map(dbRowToFork);
    res.json(forks);
  } catch (err) {
    console.error('GET /api/forks error:', err);
    res.status(500).json({ error: 'Failed to fetch forks', code: 'FETCH_FORKS_FAILED' });
  }
});

// ── POST /api/forks/refresh — fetch from GitHub, detect unread, upsert, return ──
router.post('/api/forks/refresh', async (_req, res) => {
  try {
    const result = await refreshForksFromGitHub();
    res.json(result.forks);
  } catch (err) {
    console.error('POST /api/forks/refresh error:', err);
    if (err instanceof Error && err.message === 'GitHub token not configured') {
      res.status(400).json({ error: 'GitHub token not configured', code: 'GITHUB_TOKEN_NOT_CONFIGURED' });
    } else if (err instanceof Error && err.message.startsWith('GitHub API request failed')) {
      res.status(502).json({ error: 'GitHub API request failed', code: 'GITHUB_API_FAILED' });
    } else {
      res.status(500).json({ error: 'Failed to refresh forks', code: 'REFRESH_FORKS_FAILED' });
    }
  }
});

// ── POST /api/forks/:id/mark-read ──
router.post('/api/forks/:id/mark-read', (req, res) => {
  try {
    const db = getDb();
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ error: 'Valid fork id required', code: 'INVALID_FORK_ID' });
      return;
    }

    // Fetch current source_pushed_at to set as the "read up to" point
    const fork = db.prepare('SELECT source, parent FROM forks WHERE id = ?').get(id) as { source: string; parent: string } | undefined;
    if (!fork) {
      res.status(404).json({ error: 'Fork not found', code: 'FORK_NOT_FOUND' });
      return;
    }

    try {
      const source = JSON.parse(fork.source || '{}');
      const parent = JSON.parse(fork.parent || '{}');
      const sourcePushedAt = source?.pushed_at || parent?.pushed_at;
      if (sourcePushedAt) {
        db.prepare('UPDATE forks SET is_read = 1, upstream_pushed_at = ? WHERE id = ?').run(sourcePushedAt, id);
      } else {
        db.prepare('UPDATE forks SET is_read = 1 WHERE id = ?').run(id);
      }
    } catch {
      db.prepare('UPDATE forks SET is_read = 1 WHERE id = ?').run(id);
    }
    res.json({ id, marked_read: true });
  } catch (err) {
    console.error('POST /api/forks/:id/mark-read error:', err);
    res.status(500).json({ error: 'Failed to mark fork as read', code: 'MARK_FORK_READ_FAILED' });
  }
});

// ── POST /api/forks/mark-all-read ──
router.post('/api/forks/mark-all-read', (_req, res) => {
  try {
    const db = getDb();

    // For each fork, update upstream_pushed_at to the latest source.pushed_at
    const rows = db.prepare('SELECT id, source, parent FROM forks WHERE is_read = 0').all() as Array<{ id: number; source: string; parent: string }>;
    const updateStmt = db.prepare('UPDATE forks SET is_read = 1, upstream_pushed_at = ? WHERE id = ?');
    const markReadOnlyStmt = db.prepare('UPDATE forks SET is_read = 1 WHERE id = ?');

    const markAll = db.transaction(() => {
      for (const row of rows) {
        try {
          const source = JSON.parse(row.source || '{}');
          const parent = JSON.parse(row.parent || '{}');
          const sourcePushedAt = source?.pushed_at || parent?.pushed_at;
          if (sourcePushedAt) {
            updateStmt.run(sourcePushedAt, row.id);
          } else {
            markReadOnlyStmt.run(row.id);
          }
        } catch {
          markReadOnlyStmt.run(row.id);
        }
      }
    });

    markAll();
    res.json({ marked_all_read: true, count: rows.length });
  } catch (err) {
    console.error('POST /api/forks/mark-all-read error:', err);
    res.status(500).json({ error: 'Failed to mark all forks as read', code: 'MARK_ALL_FORKS_READ_FAILED' });
  }
});

export default router;
