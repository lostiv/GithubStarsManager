import { Router } from 'express';
import { getDb } from '../db/connection.js';
import { decrypt } from '../services/crypto.js';
import { config } from '../config.js';
import { proxyRequest } from '../services/proxyService.js';

const router = Router();

// ── Helpers ──

function getGitHubToken(): string {
  const db = getDb();
  const tokenRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('github_token') as { value: string } | undefined;
  if (!tokenRow?.value) {
    throw new Error('GitHub token not configured');
  }
  return decrypt(tokenRow.value, config.encryptionKey);
}

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
    const db = getDb();
    const token = getGitHubToken();

    // Fetch all forks from GitHub (paginated)
    const allForks: Record<string, unknown>[] = [];
    let page = 1;
    const perPage = 100;
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'GithubStarsManager-Backend',
    };

    const maxPages = 100;
    while (true) {
      if (page > maxPages) {
        console.warn(`[forks] Reached max page limit (${maxPages}), stopping pagination`);
        break;
      }
      const url = `https://api.github.com/user/repos?type=forks&sort=updated&per_page=${perPage}&page=${page}`;
      const result = await proxyRequest({ url, method: 'GET', headers, timeout: 30000 });
      if (result.status !== 200) {
        res.status(502).json({ error: 'GitHub API request failed', code: 'GITHUB_API_FAILED', details: result.data });
        return;
      }
      const data = result.data as Record<string, unknown>[];
      if (!Array.isArray(data)) break;
      allForks.push(...data);
      if (data.length < perPage) break;
      page++;
    }

    // Load existing state from DB for comparison
    const existingRows = db.prepare('SELECT id, upstream_pushed_at, is_read FROM forks').all() as Array<{
      id: number;
      upstream_pushed_at: string | null;
      is_read: number;
    }>;
    const existingMap = new Map(existingRows.map(r => [r.id, r]));

    const now = new Date().toISOString();
    const upsertStmt = db.prepare(`
      INSERT OR REPLACE INTO forks (
        id, name, full_name, description, html_url, stargazers_count, forks_count, forks,
        language, created_at, updated_at, pushed_at, default_branch,
        owner, source, parent, is_read, upstream_pushed_at, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const enrichedForks: Record<string, unknown>[] = [];

    const bulkUpsert = db.transaction(() => {
      for (const raw of allForks) {
        const id = raw.id as number;
        const full_name = raw.full_name as string;
        const source = raw.source as Record<string, unknown> | undefined;
        const sourcePushedAt = source?.pushed_at as string | undefined;
        const existing = existingMap.get(id);

        let isRead = 1; // default: read
        let upstreamPushedAt = sourcePushedAt ?? null;

        if (existing) {
          if (sourcePushedAt && existing.upstream_pushed_at && sourcePushedAt !== existing.upstream_pushed_at) {
            // Upstream has new pushes — mark as unread
            isRead = 0;
            upstreamPushedAt = sourcePushedAt;
          } else {
            // Preserve existing state
            isRead = existing.is_read;
            upstreamPushedAt = existing.upstream_pushed_at ?? sourcePushedAt ?? null;
          }
        } else {
          // New fork — start as unread so user notices it
          isRead = 0;
        }

        upsertStmt.run(
          id,
          raw.name ?? '',
          full_name ?? '',
          raw.description ?? null,
          raw.html_url ?? '',
          raw.stargazers_count ?? 0,
          raw.forks_count ?? 0,
          raw.forks ?? 0,
          raw.language ?? null,
          raw.created_at ?? null,
          raw.updated_at ?? null,
          raw.pushed_at ?? null,
          raw.default_branch ?? 'main',
          JSON.stringify(raw.owner ?? {}),
          source ? JSON.stringify(source) : null,
          raw.parent ? JSON.stringify(raw.parent) : null,
          isRead,
          upstreamPushedAt,
          now
        );

        enrichedForks.push({
          ...raw,
          has_unread: !isRead,
          upstream_updated_at: upstreamPushedAt,
        });
      }
    });

    bulkUpsert();

    console.log(`[forks] Refreshed ${enrichedForks.length} forks from GitHub`);
    res.json(enrichedForks);
  } catch (err) {
    console.error('POST /api/forks/refresh error:', err);
    res.status(500).json({ error: 'Failed to refresh forks', code: 'REFRESH_FORKS_FAILED' });
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
    const fork = db.prepare('SELECT source FROM forks WHERE id = ?').get(id) as { source: string } | undefined;
    if (!fork) {
      res.status(404).json({ error: 'Fork not found', code: 'FORK_NOT_FOUND' });
      return;
    }

    let upstreamPushedAt: string | null = null;
    try {
      const source = JSON.parse(fork.source || '{}');
      upstreamPushedAt = source?.pushed_at ?? null;
    } catch { /* ignore */ }

    db.prepare('UPDATE forks SET is_read = 1, upstream_pushed_at = ? WHERE id = ?').run(upstreamPushedAt, id);
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
    const rows = db.prepare('SELECT id, source FROM forks WHERE is_read = 0').all() as Array<{ id: number; source: string }>;
    const updateStmt = db.prepare('UPDATE forks SET is_read = 1, upstream_pushed_at = ? WHERE id = ?');

    const markAll = db.transaction(() => {
      for (const row of rows) {
        let upstreamPushedAt: string | null = null;
        try {
          const source = JSON.parse(row.source || '{}');
          upstreamPushedAt = source?.pushed_at ?? null;
        } catch { /* ignore */ }
        updateStmt.run(upstreamPushedAt, row.id);
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
