import { getDb } from '../db/connection.js';
import { decrypt } from '../services/crypto.js';
import { config } from '../config.js';
import { proxyRequest } from '../services/proxyService.js';

export function getGitHubToken(): string {
  const db = getDb();
  const tokenRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('github_token') as { value: string } | undefined;
  if (!tokenRow?.value) {
    throw new Error('GitHub token not configured');
  }
  return decrypt(tokenRow.value, config.encryptionKey);
}

export async function refreshForksFromGitHub(): Promise<{ forks: Record<string, unknown>[]; count: number }> {
  const db = getDb();
  const token = getGitHubToken();

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
      throw new Error(`GitHub API request failed: HTTP ${result.status}`);
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

      let isRead = 1;
      let upstreamPushedAt = sourcePushedAt ?? null;

      if (existing) {
        if (sourcePushedAt && sourcePushedAt !== existing.upstream_pushed_at) {
          isRead = 0;
          upstreamPushedAt = sourcePushedAt;
        } else {
          isRead = existing.is_read;
          upstreamPushedAt = existing.upstream_pushed_at ?? sourcePushedAt ?? null;
        }
      } else {
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
        fetched_at: now,
      });
    }
  });

  bulkUpsert();

  console.log(`[forks] Refreshed ${enrichedForks.length} forks from GitHub`);
  return { forks: enrichedForks, count: enrichedForks.length };
}
