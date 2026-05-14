import { getDb } from '../db/connection.js';
import { proxyRequest } from '../services/proxyService.js';
import { getGitHubToken, refreshForksFromGitHub } from './forkService.js';

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let lastSyncTime: number | null = null;
let isSyncing = false;
let lastTokenWarningTime = 0;

function loadStateFromDb(): void {
  try {
    const db = getDb();
    const row = db.prepare("SELECT value FROM settings WHERE key = 'auto_sync_last_time'").get() as { value: string } | undefined;
    if (row?.value) {
      lastSyncTime = parseInt(row.value, 10) || null;
    }
  } catch {
    // ignore
  }
}

function setLastSyncTime(time: number): void {
  lastSyncTime = time;
  try {
    const db = getDb();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('auto_sync_last_time', ?)").run(String(time));
  } catch { /* ignore */ }
}

function githubHeaders(token: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github.v3+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'GithubStarsManager-Backend',
  };
}

// ── Starred repos sync ──

async function syncStarredRepos(token: string): Promise<number> {
  const db = getDb();

  // Paginate through all starred repos
  const allStarred: Record<string, unknown>[] = [];
  let page = 1;
  const perPage = 100;
  const headers = {
    ...githubHeaders(token),
    'Accept': 'application/vnd.github.star+json',
  };

  const maxPages = 200;
  while (true) {
    if (page > maxPages) {
      console.warn(`[AutoSync] Reached max page limit (${maxPages}) for starred repos`);
      break;
    }
    const url = `https://api.github.com/user/starred?per_page=${perPage}&page=${page}&sort=updated`;
    const result = await proxyRequest({ url, method: 'GET', headers, timeout: 30000 });
    if (result.status !== 200) {
      throw new Error(`GitHub starred API failed: HTTP ${result.status}`);
    }
    const data = result.data as Record<string, unknown>[];
    if (!Array.isArray(data)) break;

    for (const item of data) {
      const repo = (item as { repo?: Record<string, unknown> }).repo;
      const starredAt = (item as { starred_at?: string }).starred_at;
      if (repo) {
        allStarred.push({ ...repo, starred_at: starredAt ?? (repo.starred_at ?? null) });
      }
    }
    if (data.length < perPage) break;
    page++;
  }

  // Load existing repos from DB for merging
  const existingRows = db.prepare(`
    SELECT id, ai_summary, ai_tags, ai_platforms, analyzed_at, analysis_failed,
           custom_description, custom_tags, custom_category, category_locked, last_edited,
           subscribed_to_releases, forks_count, forks, last_release_fetch_time, has_fetched_releases
    FROM repositories
  `).all() as Record<string, unknown>[];

  const existingMap = new Map(existingRows.map(r => [r.id as number, r]));
  const newIds = new Set(allStarred.map(r => r.id as number).filter(id => id > 0));

  const upsertStmt = db.prepare(`
    INSERT OR REPLACE INTO repositories (
      id, name, full_name, description, html_url, stargazers_count, language,
      created_at, updated_at, pushed_at, starred_at,
      owner_login, owner_avatar_url, topics,
      ai_summary, ai_tags, ai_platforms, analyzed_at, analysis_failed,
      custom_description, custom_tags, custom_category, category_locked, last_edited,
      subscribed_to_releases,
      forks_count, forks, last_release_fetch_time, has_fetched_releases
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const deleteReposNotIn = (placeholders: string) =>
    db.prepare(`DELETE FROM repositories WHERE id NOT IN (${placeholders})`);

  const deleteReleasesNotIn = (placeholders: string) =>
    db.prepare(`DELETE FROM releases WHERE repo_id NOT IN (${placeholders})`);

  let count = 0;

  const bulkUpsert = db.transaction(() => {
    // Full sync: delete repos no longer starred
    if (newIds.size > 0) {
      const ids = Array.from(newIds);
      const placeholders = ids.map(() => '?').join(', ');
      deleteReleasesNotIn(placeholders).run(...ids);
      deleteReposNotIn(placeholders).run(...ids);
    } else {
      db.prepare('DELETE FROM releases').run();
      db.prepare('DELETE FROM repositories').run();
      return 0;
    }

    for (const repo of allStarred) {
      const id = repo.id as number;
      if (!id || id <= 0) continue;

      const owner = repo.owner as { login?: string; avatar_url?: string } | undefined;
      const existing = existingMap.get(id);

      // Preserve existing data when incoming has none
      const existingAI = existing as Record<string, unknown> | undefined;
      const hasIncomingAI =
        (repo.ai_summary != null && repo.ai_summary !== '') ||
        (Array.isArray(repo.ai_tags) && (repo.ai_tags as unknown[]).length > 0) ||
        (Array.isArray(repo.ai_platforms) && (repo.ai_platforms as unknown[]).length > 0) ||
        repo.analyzed_at != null ||
        repo.analysis_failed === true || repo.analysis_failed === 1;
      const hasIncomingSummary = repo.ai_summary != null && repo.ai_summary !== '';
      const hasIncomingTags = Array.isArray(repo.ai_tags) && (repo.ai_tags as unknown[]).length > 0;
      const hasIncomingPlatforms = Array.isArray(repo.ai_platforms) && (repo.ai_platforms as unknown[]).length > 0;
      const hasIncomingAnalyzedAt = repo.analyzed_at != null;

      const aiSummary = hasIncomingSummary ? repo.ai_summary : (existingAI?.ai_summary ?? null);
      const aiTagsJson = hasIncomingTags ? JSON.stringify(repo.ai_tags) : (existingAI?.ai_tags ?? '[]');
      const aiPlatformsJson = hasIncomingPlatforms ? JSON.stringify(repo.ai_platforms) : (existingAI?.ai_platforms ?? '[]');
      const analyzedAt = hasIncomingAnalyzedAt ? repo.analyzed_at : (existingAI?.analyzed_at ?? null);
      const analysisFailed = hasIncomingAI
        ? ((repo.analysis_failed === true || repo.analysis_failed === 1) ? 1 : 0)
        : (existingAI?.analysis_failed ?? 0);

      upsertStmt.run(
        id, repo.name ?? '', repo.full_name ?? '', repo.description ?? null,
        repo.html_url ?? '', repo.stargazers_count ?? 0, repo.language ?? null,
        repo.created_at ?? null, repo.updated_at ?? null, repo.pushed_at ?? null,
        repo.starred_at ?? null,
        owner?.login ?? '', owner?.avatar_url ?? null,
        JSON.stringify(Array.isArray(repo.topics) ? repo.topics : []),
        aiSummary, aiTagsJson, aiPlatformsJson, analyzedAt, analysisFailed,
        existingAI?.custom_description ?? null,
        existingAI?.custom_tags ?? '[]',
        existingAI?.custom_category ?? null,
        existingAI?.category_locked ?? 0,
        existingAI?.last_edited ?? null,
        existingAI?.subscribed_to_releases ?? 0,
        existingAI?.forks_count ?? 0,
        existingAI?.forks ?? 0,
        existingAI?.last_release_fetch_time ?? null,
        existingAI?.has_fetched_releases ?? 0
      );
      count++;
    }
    return count;
  });

  bulkUpsert();
  console.log(`[AutoSync] Synced ${count} starred repos (${allStarred.length} from GitHub)`);
  return count;
}

// ── Release sync ──

async function syncReleases(token: string): Promise<number> {
  const db = getDb();
  const subscribedRepos = db.prepare(`
    SELECT id, full_name, has_fetched_releases, last_release_fetch_time
    FROM repositories WHERE subscribed_to_releases = 1
  `).all() as Array<{
    id: number;
    full_name: string;
    has_fetched_releases: number;
    last_release_fetch_time: string | null;
  }>;

  if (subscribedRepos.length === 0) {
    console.log('[AutoSync] No subscribed repos for release sync');
    return 0;
  }

  const headers = githubHeaders(token);
  let totalReleases = 0;

  for (const repo of subscribedRepos) {
    const [owner, name] = repo.full_name.split('/');
    try {
      const releases: Record<string, unknown>[] = [];

      if (!repo.has_fetched_releases) {
        // First fetch: get all releases
        let page = 1;
        const maxPages = 50;
        while (page <= maxPages) {
          const url = `https://api.github.com/repos/${owner}/${name}/releases?per_page=100&page=${page}`;
          const result = await proxyRequest({ url, method: 'GET', headers, timeout: 30000 });
          if (result.status !== 200) {
            console.warn(`[AutoSync] Failed to fetch releases for ${repo.full_name}: HTTP ${result.status}`);
            break;
          }
          const batch = result.data as Record<string, unknown>[];
          if (!Array.isArray(batch) || batch.length === 0) break;
          releases.push(...batch);
          if (batch.length < 100) break;
          page++;
        }
      } else {
        // 增量：仅拉取上次同步之后有新发布的 release
        // 不按 created_at 断点 — API 排序与过滤字段不一致，提前断点会遗漏后面页的发布
        const sinceTime = repo.last_release_fetch_time ? new Date(repo.last_release_fetch_time) : null;
        let page = 1;
        const maxPages = 50;
        while (page <= maxPages) {
          const url = `https://api.github.com/repos/${owner}/${name}/releases?per_page=100&page=${page}`;
          const result = await proxyRequest({ url, method: 'GET', headers, timeout: 30000 });
          if (result.status !== 200) {
            console.warn(`[AutoSync] Failed to fetch releases for ${repo.full_name}: HTTP ${result.status}`);
            break;
          }
          const batch = result.data as Record<string, unknown>[];
          if (!Array.isArray(batch) || batch.length === 0) break;

          const fresh = sinceTime
            ? batch.filter(r => {
                // 优先用 published_at；Draft 为 null 时回退到 created_at
                const pubDate = r.published_at ? new Date(r.published_at as string) : null;
                const compareDate = pubDate && !isNaN(pubDate.getTime()) ? pubDate : new Date(r.created_at as string);
                return !isNaN(compareDate.getTime()) && compareDate > sinceTime;
              })
            : batch;

          releases.push(...fresh);

          if (batch.length < 100) break;
          page++;
        }
      }

      if (releases.length > 0) {
        const upsertStmt = db.prepare(`
          INSERT OR REPLACE INTO releases (
            id, tag_name, name, body, html_url, published_at, assets,
            repo_id, repo_full_name, repo_name, prerelease, draft, is_read
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const bulkUpsert = db.transaction(() => {
          for (const rel of releases) {
            upsertStmt.run(
              rel.id ?? null,
              rel.tag_name ?? '',
              rel.name ?? null,
              rel.body ?? null,
              rel.html_url ?? '',
              rel.published_at ?? null,
              JSON.stringify(rel.assets ?? []),
              repo.id,
              repo.full_name,
              name,
              rel.prerelease ? 1 : 0,
              rel.draft ? 1 : 0,
              0
            );
          }
        });

        bulkUpsert();
        totalReleases += releases.length;
      }

      // Update fetch metadata for this repo
      db.prepare(`
        UPDATE repositories SET last_release_fetch_time = ?, has_fetched_releases = 1 WHERE id = ?
      `).run(new Date().toISOString(), repo.id);
    } catch (err) {
      console.warn(`[AutoSync] Error syncing releases for ${repo.full_name}:`, err);
    }
  }

  console.log(`[AutoSync] Synced ${totalReleases} releases across ${subscribedRepos.length} repos`);
  return totalReleases;
}

// ── Main sync orchestration ──

export async function performAutoSync(): Promise<{ success: boolean; types: string[]; error?: string }> {
  if (isSyncing) {
    return { success: false, types: [], error: '另一个同步任务正在执行中' };
  }
  isSyncing = true;
  const syncedTypes: string[] = [];

  try {
    const db = getDb();

    const enabledRepos = db.prepare("SELECT value FROM settings WHERE key = 'auto_sync_enabled_repos'").get() as { value: string } | undefined;
    const enabledForks = db.prepare("SELECT value FROM settings WHERE key = 'auto_sync_enabled_forks'").get() as { value: string } | undefined;
    const enabledReleases = db.prepare("SELECT value FROM settings WHERE key = 'auto_sync_enabled_releases'").get() as { value: string } | undefined;

    const anyEnabled = enabledRepos?.value === 'true' || enabledForks?.value === 'true' || enabledReleases?.value === 'true';
    if (!anyEnabled) {
      return { success: false, types: [], error: '没有启用任何同步类型' };
    }

    const token = getGitHubToken();

    if (enabledRepos?.value === 'true') {
      await syncStarredRepos(token);
      syncedTypes.push('repos');
    }

    if (enabledForks?.value === 'true') {
      await refreshForksFromGitHub();
      syncedTypes.push('forks');
    }

    if (enabledReleases?.value === 'true') {
      await syncReleases(token);
      syncedTypes.push('releases');
    }

    setLastSyncTime(Date.now());
    console.log(`[AutoSync] Sync completed. Types: ${syncedTypes.join(', ')}`);

    return { success: true, types: syncedTypes };
  } catch (err) {
    console.error('[AutoSync] Sync failed:', err);
    return { success: false, types: syncedTypes, error: err instanceof Error ? err.message : '未知错误' };
  } finally {
    isSyncing = false;
  }
}

// ── Scheduler ──

export function startAutoSyncScheduler(): void {
  if (schedulerTimer) return;

  loadStateFromDb();

  // Initial check 5 seconds after startup
  setTimeout(() => {
    checkAndSync().catch((err) => console.warn('[AutoSync] Initial check failed:', err));
  }, 5000);

  schedulerTimer = setInterval(() => {
    checkAndSync().catch((err) => console.warn('[AutoSync] Scheduled check failed:', err));
  }, 60000);
}

export function stopAutoSyncScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

async function checkAndSync(): Promise<void> {
  const db = getDb();

  const enabledRepos = db.prepare("SELECT value FROM settings WHERE key = 'auto_sync_enabled_repos'").get() as { value: string } | undefined;
  const enabledForks = db.prepare("SELECT value FROM settings WHERE key = 'auto_sync_enabled_forks'").get() as { value: string } | undefined;
  const enabledReleases = db.prepare("SELECT value FROM settings WHERE key = 'auto_sync_enabled_releases'").get() as { value: string } | undefined;

  const anyEnabled = enabledRepos?.value === 'true' || enabledForks?.value === 'true' || enabledReleases?.value === 'true';
  if (!anyEnabled) return;

  const intervalRow = db.prepare("SELECT value FROM settings WHERE key = 'auto_sync_interval_minutes'").get() as { value: string } | undefined;
  const intervalMinutes = intervalRow ? parseInt(intervalRow.value, 10) || 1440 : 1440;
  const intervalMs = intervalMinutes * 60 * 1000;

  if (lastSyncTime && (Date.now() - lastSyncTime) < intervalMs) return;

  try {
    getGitHubToken();
    lastTokenWarningTime = 0;
  } catch {
    // 每30分钟最多报一次，避免每分钟刷屏
    if (Date.now() - lastTokenWarningTime > 1800000) {
      console.warn('[AutoSync] GitHub token not configured, skipping');
      lastTokenWarningTime = Date.now();
    }
    return;
  }

  await performAutoSync();
}

// ── Status ──

export function getAutoSyncStatus(): {
  lastSyncTime: string | null;
  nextScheduledTime: string | null;
  isEnabled: boolean;
  enabledRepos: boolean;
  enabledForks: boolean;
  enabledReleases: boolean;
  intervalMinutes: number;
  isSyncing: boolean;
  githubTokenConfigured: boolean;
} {
  const db = getDb();

  const enabledRepos = db.prepare("SELECT value FROM settings WHERE key = 'auto_sync_enabled_repos'").get() as { value: string } | undefined;
  const enabledForks = db.prepare("SELECT value FROM settings WHERE key = 'auto_sync_enabled_forks'").get() as { value: string } | undefined;
  const enabledReleases = db.prepare("SELECT value FROM settings WHERE key = 'auto_sync_enabled_releases'").get() as { value: string } | undefined;

  const isEnabled = enabledRepos?.value === 'true' || enabledForks?.value === 'true' || enabledReleases?.value === 'true';

  const intervalRow = db.prepare("SELECT value FROM settings WHERE key = 'auto_sync_interval_minutes'").get() as { value: string } | undefined;
  const intervalMinutes = intervalRow ? parseInt(intervalRow.value, 10) || 1440 : 1440;

  const nextScheduledTime = (isEnabled && lastSyncTime)
    ? new Date(lastSyncTime + intervalMinutes * 60 * 1000).toISOString()
    : null;

  const tokenRow = db.prepare("SELECT value FROM settings WHERE key = 'github_token'").get() as { value: string } | undefined;
  const githubTokenConfigured = !!tokenRow?.value;

  return {
    lastSyncTime: lastSyncTime ? new Date(lastSyncTime).toISOString() : null,
    nextScheduledTime,
    isEnabled,
    enabledRepos: enabledRepos?.value === 'true',
    enabledForks: enabledForks?.value === 'true',
    enabledReleases: enabledReleases?.value === 'true',
    intervalMinutes,
    isSyncing,
    githubTokenConfigured,
  };
}
