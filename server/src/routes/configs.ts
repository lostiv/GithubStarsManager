import { Router } from 'express';
import { getDb } from '../db/connection.js';
import { encrypt, decrypt } from '../services/crypto.js';
import { config } from '../config.js';

const router = Router();

type SecretStatus = 'ok' | 'empty' | 'decrypt_failed';

function getMaskedSecretResult(params: {
  encryptedValue: unknown;
  encryptionKey: string;
  kind: 'AI API key' | 'WebDAV password' | 'GitHub token';
  configId?: unknown;
  configName?: unknown;
}): { decryptedValue: string; status: SecretStatus } {
  const { encryptedValue, encryptionKey, kind, configId, configName } = params;

  if (!encryptedValue || typeof encryptedValue !== 'string') {
    return { decryptedValue: '', status: 'empty' };
  }

  try {
    return {
      decryptedValue: decrypt(encryptedValue, encryptionKey),
      status: 'ok',
    };
  } catch (error) {
    const detail = [configId ? `id=${String(configId)}` : '', configName ? `name=${String(configName)}` : '']
      .filter(Boolean)
      .join(', ');
    console.warn(`[configs] Failed to decrypt ${kind}${detail ? ` (${detail})` : ''}:`, error);
    return { decryptedValue: '', status: 'decrypt_failed' };
  }
}

// ── AI Configs ──

function maskApiKey(key: string | null | undefined): string {
  if (!key || typeof key !== 'string') return '';
  if (key.length <= 4) return '****';
  return '***' + key.slice(-4);
}

// GET /api/configs/ai
router.get('/api/configs/ai', (req, res) => {
  try {
    const db = getDb();
    const shouldDecrypt = req.query.decrypt === 'true';
    const rows = db.prepare('SELECT * FROM ai_configs ORDER BY id ASC').all() as Record<string, unknown>[];
    const configs = rows.map((row) => {
      const { decryptedValue, status } = getMaskedSecretResult({
        encryptedValue: row.api_key_encrypted,
        encryptionKey: config.encryptionKey,
        kind: 'AI API key',
        configId: row.id,
        configName: row.name,
      });
      return {
        id: row.id,
        name: row.name,
        apiType: row.api_type,
        model: row.model,
        baseUrl: row.base_url,
        apiKey: shouldDecrypt ? decryptedValue : maskApiKey(decryptedValue),
        apiKeyStatus: status,
        isActive: !!row.is_active,
        customPrompt: row.custom_prompt ?? null,
        useCustomPrompt: !!row.use_custom_prompt,
        concurrency: row.concurrency ?? 1,
        reasoningEffort: row.reasoning_effort ?? null,
      };
    });
    res.json(configs);
  } catch (err) {
    console.error('GET /api/configs/ai error:', err);
    res.status(500).json({ error: 'Failed to fetch AI configs', code: 'FETCH_AI_CONFIGS_FAILED' });
  }
});

// POST /api/configs/ai
router.post('/api/configs/ai', (req, res) => {
  try {
    const db = getDb();
    const { name, apiType, model, baseUrl, apiKey, isActive, customPrompt, useCustomPrompt, concurrency, reasoningEffort } = req.body as Record<string, unknown>;

    const encryptedKey = apiKey && typeof apiKey === 'string' ? encrypt(apiKey, config.encryptionKey) : null;

    const result = db.prepare(
      'INSERT INTO ai_configs (name, api_type, model, base_url, api_key_encrypted, is_active, custom_prompt, use_custom_prompt, concurrency, reasoning_effort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      name ?? '', apiType ?? 'openai', model ?? '', baseUrl ?? null,
      encryptedKey, isActive ? 1 : 0, customPrompt ?? null, useCustomPrompt ? 1 : 0, concurrency ?? 1, reasoningEffort ?? null
    );

    res.status(201).json({ id: result.lastInsertRowid, name, apiType, model, baseUrl, apiKey: maskApiKey(apiKey as string), isActive: !!isActive, reasoningEffort: reasoningEffort ?? null });
  } catch (err) {
    console.error('POST /api/configs/ai error:', err);
    res.status(500).json({ error: 'Failed to create AI config', code: 'CREATE_AI_CONFIG_FAILED' });
  }
});

// PUT /api/configs/ai/bulk — replace all AI configs (for sync)
// MUST be registered before :id route to avoid matching 'bulk' as an id
router.put('/api/configs/ai/bulk', (req, res) => {
  try {
    const db = getDb();
    const configs = req.body.configs as Array<{
      id: string;
      name: string;
      apiType?: string;
      baseUrl: string;
      apiKey: string;
      model: string;
      isActive: boolean;
      customPrompt?: string;
      useCustomPrompt?: boolean;
      concurrency?: number;
      reasoningEffort?: string;
    }>;

    if (!Array.isArray(configs)) {
      res.status(400).json({ error: 'configs array required', code: 'INVALID_REQUEST' });
      return;
    }

    const bulkSync = db.transaction(() => {
      const existingKeys = new Map<string, string>();
      const existingRows = db.prepare('SELECT id, api_key_encrypted FROM ai_configs').all() as Array<{ id: string; api_key_encrypted: string }>;
      for (const row of existingRows) {
        if (row.api_key_encrypted) existingKeys.set(String(row.id), row.api_key_encrypted);
      }

      db.prepare('DELETE FROM ai_configs').run();

      const stmt = db.prepare(`
        INSERT INTO ai_configs (id, name, api_type, base_url, api_key_encrypted, model, is_active, custom_prompt, use_custom_prompt, concurrency, reasoning_effort)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const skippedConfigs: Array<{ id: string; name: string; reason: string }> = [];

      for (const c of configs) {
        let encryptedKey = '';
        if (c.apiKey && !c.apiKey.startsWith('***')) {
          encryptedKey = encrypt(c.apiKey, config.encryptionKey);
        } else {
          encryptedKey = existingKeys.get(String(c.id)) ?? '';
        }

        if (!encryptedKey) {
          skippedConfigs.push({
            id: c.id,
            name: c.name ?? '',
            reason: c.apiKey?.startsWith('***')
              ? 'API key is masked and no existing key found'
              : 'API key is empty',
          });
          continue;
        }

        stmt.run(
          c.id, c.name ?? '', c.apiType ?? 'openai', c.baseUrl ?? '',
          encryptedKey, c.model ?? '', c.isActive ? 1 : 0,
          c.customPrompt ?? null, c.useCustomPrompt ? 1 : 0, c.concurrency ?? 1, c.reasoningEffort ?? null
        );
      }

      if (skippedConfigs.length > 0) {
        console.warn('[configs] Skipped AI configs with missing keys:', skippedConfigs);
      }
    });

    bulkSync();
    res.json({ synced: configs.length });
  } catch (err) {
    console.error('PUT /api/configs/ai/bulk error:', err);
    res.status(500).json({ error: 'Failed to sync AI configs', code: 'SYNC_AI_CONFIGS_FAILED' });
  }
});

// PUT /api/configs/ai/:id
router.put('/api/configs/ai/:id', (req, res) => {
  try {
    const db = getDb();
    const id = req.params.id;
    const { name, apiType, model, baseUrl, apiKey, isActive, customPrompt, useCustomPrompt, concurrency, reasoningEffort } = req.body as Record<string, unknown>;

    let encryptedKey: string | null = null;
    if (apiKey && typeof apiKey === 'string' && !apiKey.startsWith('***')) {
      encryptedKey = encrypt(apiKey, config.encryptionKey);
    } else {
      // Keep existing encrypted key
      const existing = db.prepare('SELECT api_key_encrypted FROM ai_configs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      encryptedKey = (existing?.api_key_encrypted as string) ?? null;
    }

    const result = db.prepare(
      'UPDATE ai_configs SET name = ?, api_type = ?, model = ?, base_url = ?, api_key_encrypted = ?, is_active = ?, custom_prompt = ?, use_custom_prompt = ?, concurrency = ?, reasoning_effort = ? WHERE id = ?'
    ).run(name ?? '', apiType ?? 'openai', model ?? '', baseUrl ?? null, encryptedKey, isActive ? 1 : 0, customPrompt ?? null, useCustomPrompt ? 1 : 0, concurrency ?? 1, reasoningEffort ?? null, id);

    if (result.changes === 0) {
      res.status(404).json({ error: 'AI config not found', code: 'AI_CONFIG_NOT_FOUND' });
      return;
    }
    let maskedKey = '';
    if (encryptedKey) {
      try { maskedKey = maskApiKey(decrypt(encryptedKey, config.encryptionKey)); } catch { maskedKey = '****'; }
    }

    res.json({ id, name, apiType, model, baseUrl, apiKey: maskedKey, isActive: !!isActive, reasoningEffort: reasoningEffort ?? null });
  } catch (err) {
    console.error('PUT /api/configs/ai error:', err);
    res.status(500).json({ error: 'Failed to update AI config', code: 'UPDATE_AI_CONFIG_FAILED' });
  }
});

// DELETE /api/configs/ai/:id
router.delete('/api/configs/ai/:id', (req, res) => {
  try {
    const db = getDb();
    const id = req.params.id;
    const result = db.prepare('DELETE FROM ai_configs WHERE id = ?').run(id);
    if (result.changes === 0) {
      res.status(404).json({ error: 'AI config not found', code: 'AI_CONFIG_NOT_FOUND' });
      return;
    }
    res.json({ deleted: true });
  } catch (err) {
    console.error('DELETE /api/configs/ai error:', err);
    res.status(500).json({ error: 'Failed to delete AI config', code: 'DELETE_AI_CONFIG_FAILED' });
  }
});

// ── WebDAV Configs ──

function maskPassword(pwd: string | null | undefined): string {
  if (!pwd || typeof pwd !== 'string') return '';
  if (pwd.length <= 4) return '****';
  return '***' + pwd.slice(-4);
}

// GET /api/configs/webdav
router.get('/api/configs/webdav', (req, res) => {
  try {
    const db = getDb();
    const shouldDecrypt = req.query.decrypt === 'true';
    const rows = db.prepare('SELECT * FROM webdav_configs ORDER BY id ASC').all() as Record<string, unknown>[];
    const configs = rows.map((row) => {
      const { decryptedValue, status } = getMaskedSecretResult({
        encryptedValue: row.password_encrypted,
        encryptionKey: config.encryptionKey,
        kind: 'WebDAV password',
        configId: row.id,
        configName: row.name,
      });
      return {
        id: row.id,
        name: row.name,
        url: row.url,
        username: row.username,
        password: shouldDecrypt ? decryptedValue : maskPassword(decryptedValue),
        passwordStatus: status,
        path: row.path,
        isActive: !!row.is_active,
      };
    });
    res.json(configs);
  } catch (err) {
    console.error('GET /api/configs/webdav error:', err);
    res.status(500).json({ error: 'Failed to fetch WebDAV configs', code: 'FETCH_WEBDAV_CONFIGS_FAILED' });
  }
});

// POST /api/configs/webdav
router.post('/api/configs/webdav', (req, res) => {
  try {
    const db = getDb();
    const { name, url, username, password, path, isActive } = req.body as Record<string, unknown>;

    const encryptedPwd = password && typeof password === 'string' ? encrypt(password, config.encryptionKey) : null;

    const result = db.prepare(
      'INSERT INTO webdav_configs (name, url, username, password_encrypted, path, is_active) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(
      name ?? '', url ?? '', username ?? '', encryptedPwd,
      path ?? '/', isActive ? 1 : 0
    );

    res.status(201).json({ id: result.lastInsertRowid, name, url, username, password: maskPassword(password as string), path, isActive: !!isActive });
  } catch (err) {
    console.error('POST /api/configs/webdav error:', err);
    res.status(500).json({ error: 'Failed to create WebDAV config', code: 'CREATE_WEBDAV_CONFIG_FAILED' });
  }
});

// PUT /api/configs/webdav/bulk — replace all WebDAV configs (for sync)
// MUST be registered before :id route to avoid matching 'bulk' as an id
router.put('/api/configs/webdav/bulk', (req, res) => {
  try {
    const db = getDb();
    const configs = req.body.configs as Array<{
      id: string;
      name: string;
      url: string;
      username: string;
      password: string;
      path: string;
      isActive: boolean;
    }>;

    if (!Array.isArray(configs)) {
      res.status(400).json({ error: 'configs array required', code: 'INVALID_REQUEST' });
      return;
    }

    const bulkSync = db.transaction(() => {
      // Read existing passwords BEFORE delete
      const existingPwds = new Map<string, string>();
      const existingRows = db.prepare('SELECT id, password_encrypted FROM webdav_configs').all() as Array<{ id: string; password_encrypted: string }>;
      for (const row of existingRows) {
        if (row.password_encrypted) existingPwds.set(String(row.id), row.password_encrypted);
      }

      db.prepare('DELETE FROM webdav_configs').run();

      const stmt = db.prepare(`
        INSERT INTO webdav_configs (id, name, url, username, password_encrypted, path, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      for (const c of configs) {
        let encryptedPwd = '';
        if (c.password && !c.password.startsWith('***')) {
          encryptedPwd = encrypt(c.password, config.encryptionKey);
        } else {
          encryptedPwd = existingPwds.get(String(c.id)) ?? '';
        }
        stmt.run(
          c.id, c.name ?? '', c.url ?? '', c.username ?? '',
          encryptedPwd, c.path ?? '/', c.isActive ? 1 : 0
        );
      }
    });

    bulkSync();
    res.json({ synced: configs.length });
  } catch (err) {
    console.error('PUT /api/configs/webdav/bulk error:', err);
    res.status(500).json({ error: 'Failed to sync WebDAV configs', code: 'SYNC_WEBDAV_CONFIGS_FAILED' });
  }
});

// PUT /api/configs/webdav/:id
router.put('/api/configs/webdav/:id', (req, res) => {
  try {
    const db = getDb();
    const id = req.params.id;
    const { name, url, username, password, path, isActive } = req.body as Record<string, unknown>;

    let encryptedPwd: string | null = null;
    if (password && typeof password === 'string' && !password.startsWith('***')) {
      encryptedPwd = encrypt(password, config.encryptionKey);
    } else {
      const existing = db.prepare('SELECT password_encrypted FROM webdav_configs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      encryptedPwd = (existing?.password_encrypted as string) ?? null;
    }

    const result = db.prepare(
      'UPDATE webdav_configs SET name = ?, url = ?, username = ?, password_encrypted = ?, path = ?, is_active = ? WHERE id = ?'
    ).run(name ?? '', url ?? '', username ?? '', encryptedPwd, path ?? '/', isActive ? 1 : 0, id);

    if (result.changes === 0) {
      res.status(404).json({ error: 'WebDAV config not found', code: 'WEBDAV_CONFIG_NOT_FOUND' });
      return;
    }
    let maskedPwd = '';
    if (encryptedPwd) {
      try { maskedPwd = maskPassword(decrypt(encryptedPwd, config.encryptionKey)); } catch { maskedPwd = '****'; }
    }

    res.json({ id, name, url, username, password: maskedPwd, path, isActive: !!isActive });
  } catch (err) {
    console.error('PUT /api/configs/webdav error:', err);
    res.status(500).json({ error: 'Failed to update WebDAV config', code: 'UPDATE_WEBDAV_CONFIG_FAILED' });
  }
});

// DELETE /api/configs/webdav/:id
router.delete('/api/configs/webdav/:id', (req, res) => {
  try {
    const db = getDb();
    const id = req.params.id;
    const result = db.prepare('DELETE FROM webdav_configs WHERE id = ?').run(id);
    if (result.changes === 0) {
      res.status(404).json({ error: 'WebDAV config not found', code: 'WEBDAV_CONFIG_NOT_FOUND' });
      return;
    }
    res.json({ deleted: true });
  } catch (err) {
    console.error('DELETE /api/configs/webdav error:', err);
    res.status(500).json({ error: 'Failed to delete WebDAV config', code: 'DELETE_WEBDAV_CONFIG_FAILED' });
  }
});

// ── Settings ──

// GET /api/settings
router.get('/api/settings', (_req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM settings').all() as Record<string, unknown>[];
    const settings: Record<string, unknown> = {};

    for (const row of rows) {
      const key = row.key as string;
      let value = row.value as string | null;

      if (key === 'github_token' && value) {
        const { decryptedValue, status } = getMaskedSecretResult({
          encryptedValue: value,
          encryptionKey: config.encryptionKey,
          kind: 'GitHub token',
        });
        value = status === 'empty' ? '' : maskApiKey(decryptedValue);
        settings.github_token_status = status;
      }

      // Try to parse JSON values back to objects/arrays
      if (typeof value === 'string' && (value.startsWith('[') || value.startsWith('{'))) {
        try { settings[key] = JSON.parse(value); } catch { settings[key] = value; }
      } else {
        settings[key] = value;
      }
    }

    res.json(settings);
  } catch (err) {
    console.error('GET /api/settings error:', err);
    res.status(500).json({ error: 'Failed to fetch settings', code: 'FETCH_SETTINGS_FAILED' });
  }
});

// PUT /api/settings
router.put('/api/settings', (req, res) => {
  try {
    const db = getDb();
    const updates = req.body as Record<string, unknown>;

    const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');

    const upsert = db.transaction(() => {
      for (const [key, rawValue] of Object.entries(updates)) {
        let value = rawValue as string | null;

        if (key === 'github_token' && value && typeof value === 'string') {
          if (value.startsWith('***')) {
            // Skip masked values — keep existing
            continue;
          }
          value = encrypt(value, config.encryptionKey);
        }

        // better-sqlite3 interprets objects/arrays as named parameter maps,
        // causing RangeError. Serialize non-primitive values to JSON strings.
        const serialized =
          value === null || value === undefined
            ? null
            : typeof value === 'object'
              ? JSON.stringify(value)
              : value;
        stmt.run(key, serialized);
      }
    });

    upsert();
    res.json({ updated: true });
  } catch (err) {
    console.error('PUT /api/settings error:', err);
    res.status(500).json({ error: 'Failed to update settings', code: 'UPDATE_SETTINGS_FAILED' });
  }
});

// ── Embedding Configs ──

router.get('/api/configs/embedding', (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM embedding_configs ORDER BY id ASC').all() as Record<string, unknown>[];
    const configs = rows.map((row) => {
      const { decryptedValue, status } = getMaskedSecretResult({
        encryptedValue: row.api_key_encrypted,
        encryptionKey: config.encryptionKey,
        kind: 'AI API key',
        configId: row.id,
        configName: row.name,
      });
      return {
        id: row.id,
        name: row.name,
        apiType: row.api_type,
        baseUrl: row.base_url,
        apiKey: maskApiKey(decryptedValue),
        model: row.model,
        dimensions: row.dimensions,
        isActive: !!row.is_active,
        apiKeyStatus: status,
      };
    });
    res.json(configs);
  } catch (err) {
    console.error('GET /api/configs/embedding error:', err);
    res.status(500).json({ error: 'Failed to fetch embedding configs', code: 'FETCH_EMBEDDING_CONFIGS_FAILED' });
  }
});

router.post('/api/configs/embedding', (req, res) => {
  try {
    const db = getDb();
    const { id, name, apiType, baseUrl, apiKey, model, dimensions, isActive } = req.body as Record<string, unknown>;
    const configId = id || Date.now().toString();
    const encryptedKey = apiKey && typeof apiKey === 'string' ? encrypt(apiKey, config.encryptionKey) : '';

    db.prepare(
      'INSERT INTO embedding_configs (id, name, api_type, base_url, api_key_encrypted, model, dimensions, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(configId, name ?? '', apiType ?? 'openai', baseUrl ?? '', encryptedKey, model ?? '', dimensions ?? 1536, isActive ? 1 : 0);

    res.status(201).json({ id: configId, isActive: !!isActive });
  } catch (err) {
    console.error('POST /api/configs/embedding error:', err);
    res.status(500).json({ error: 'Failed to create embedding config', code: 'CREATE_EMBEDDING_CONFIG_FAILED' });
  }
});

router.put('/api/configs/embedding/:id', (req, res) => {
  try {
    const db = getDb();
    const { id } = req.params;
    const { name, apiType, baseUrl, apiKey, model, dimensions, isActive } = req.body as Record<string, unknown>;

    const existing = db.prepare('SELECT * FROM embedding_configs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Embedding config not found' });
      return;
    }

    const encryptedKey = apiKey && typeof apiKey === 'string' && !apiKey.includes('***')
      ? encrypt(apiKey, config.encryptionKey)
      : (existing.api_key_encrypted as string);

    db.prepare(
      "UPDATE embedding_configs SET name = ?, api_type = ?, base_url = ?, api_key_encrypted = ?, model = ?, dimensions = ?, is_active = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(name ?? '', apiType ?? 'openai', baseUrl ?? '', encryptedKey, model ?? '', dimensions ?? 1536, isActive ? 1 : 0, id);

    res.json({ updated: true });
  } catch (err) {
    console.error('PUT /api/configs/embedding error:', err);
    res.status(500).json({ error: 'Failed to update embedding config', code: 'UPDATE_EMBEDDING_CONFIG_FAILED' });
  }
});

router.delete('/api/configs/embedding/:id', (req, res) => {
  try {
    const db = getDb();
    const { id } = req.params;
    db.prepare('DELETE FROM embedding_configs WHERE id = ?').run(id);
    res.json({ deleted: true });
  } catch (err) {
    console.error('DELETE /api/configs/embedding error:', err);
    res.status(500).json({ error: 'Failed to delete embedding config', code: 'DELETE_EMBEDDING_CONFIG_FAILED' });
  }
});

router.put('/api/configs/embedding/bulk', (req, res) => {
  try {
    const db = getDb();
    const configs = req.body as Record<string, unknown>[];
    if (!Array.isArray(configs)) {
      res.status(400).json({ error: 'Expected array of configs' });
      return;
    }

    const upsert = db.transaction(() => {
      for (const c of configs) {
        let encryptedKey = '';
        if (c.apiKey && typeof c.apiKey === 'string' && !c.apiKey.includes('***')) {
          encryptedKey = encrypt(c.apiKey, config.encryptionKey);
        } else {
          const existing = db.prepare('SELECT api_key_encrypted FROM embedding_configs WHERE id = ?').get(c.id) as Record<string, unknown> | undefined;
          encryptedKey = (existing?.api_key_encrypted as string) ?? '';
        }
        db.prepare(
          "INSERT OR REPLACE INTO embedding_configs (id, name, api_type, base_url, api_key_encrypted, model, dimensions, is_active, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))"
        ).run(c.id, c.name ?? '', c.apiType ?? 'openai', c.baseUrl ?? '', encryptedKey, c.model ?? '', c.dimensions ?? 1536, c.isActive ? 1 : 0);
      }
    });

    upsert();
    res.json({ updated: true, count: configs.length });
  } catch (err) {
    console.error('PUT /api/configs/embedding/bulk error:', err);
    res.status(500).json({ error: 'Failed to bulk update embedding configs', code: 'BULK_UPDATE_EMBEDDING_CONFIGS_FAILED' });
  }
});

// ── Vector Search Config ──

router.get('/api/configs/vector-search', (req, res) => {
  try {
    const db = getDb();
    const row = db.prepare("SELECT * FROM vector_search_configs WHERE id = 'default'").get() as Record<string, unknown> | undefined;

    if (!row) {
      res.json({ enabled: false, workerUrl: '', authToken: '', embeddingConfigId: '', indexMode: 'readme', readmeMaxChars: 6000 });
      return;
    }

    let authToken = '';
    let authTokenStatus: SecretStatus = 'empty';
    if (row.auth_token_encrypted && typeof row.auth_token_encrypted === 'string' && row.auth_token_encrypted) {
      try {
        authToken = decrypt(row.auth_token_encrypted, config.encryptionKey);
        authTokenStatus = 'ok';
      } catch {
        authTokenStatus = 'decrypt_failed';
      }
    }

    const shouldDecrypt = req.query.decrypt === 'true';

    res.json({
      enabled: !!row.enabled,
      workerUrl: row.worker_url ?? '',
      authToken: shouldDecrypt ? authToken : (authToken ? '***' : ''),
      authTokenStatus,
      embeddingConfigId: row.embedding_config_id ?? '',
      indexMode: row.index_mode ?? 'readme',
      readmeMaxChars: row.readme_max_chars ?? 6000,
      status: row.status_json ? JSON.parse(row.status_json as string) : undefined,
      lastSyncAt: row.last_sync_at ?? null,
    });
  } catch (err) {
    console.error('GET /api/configs/vector-search error:', err);
    res.status(500).json({ error: 'Failed to fetch vector search config', code: 'FETCH_VECTOR_SEARCH_CONFIG_FAILED' });
  }
});

router.put('/api/configs/vector-search', (req, res) => {
  try {
    const db = getDb();
    const { enabled, workerUrl, authToken, embeddingConfigId, indexMode, readmeMaxChars, status, lastSyncAt } = req.body as Record<string, unknown>;

    let encryptedToken = '';
    if (typeof authToken === 'string' && !authToken.includes('***')) {
      encryptedToken = encrypt(authToken, config.encryptionKey);
    } else {
      const existing = db.prepare("SELECT auth_token_encrypted FROM vector_search_configs WHERE id = 'default'").get() as Record<string, unknown> | undefined;
      encryptedToken = (existing?.auth_token_encrypted as string) ?? '';
    }

    const mode = typeof indexMode === 'string' && ['readme', 'description'].includes(indexMode) ? indexMode : 'readme';
    const maxChars = typeof readmeMaxChars === 'number' && readmeMaxChars > 0 ? readmeMaxChars : 6000;
    const statusJson = status ? JSON.stringify(status) : null;

    db.prepare(`
      INSERT OR REPLACE INTO vector_search_configs (id, enabled, worker_url, auth_token_encrypted, embedding_config_id, index_mode, readme_max_chars, status_json, last_sync_at, updated_at)
      VALUES ('default', ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(enabled ? 1 : 0, workerUrl ?? '', encryptedToken, embeddingConfigId ?? '', mode, maxChars, statusJson, lastSyncAt ?? null);

    res.json({ updated: true });
  } catch (err) {
    console.error('PUT /api/configs/vector-search error:', err);
    res.status(500).json({ error: 'Failed to update vector search config', code: 'UPDATE_VECTOR_SEARCH_CONFIG_FAILED' });
  }
});

export default router;
