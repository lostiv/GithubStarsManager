import { Router } from 'express';
import type { Response as ExpressResponse } from 'express';
import { getDb } from '../db/connection.js';
import { decrypt } from '../services/crypto.js';
import { config } from '../config.js';
import { proxyRequest } from '../services/proxyService.js';
import net from 'net';

const router = Router();

// Helper: build API URL handling baseUrl already ending in version prefix
function buildApiUrl(baseUrl: string, pathWithVersion: string): string {
  const baseUrlWithSlash = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const versionPrefix = pathWithVersion.split('/')[0] || '';

  try {
    const base = new URL(baseUrlWithSlash);
    const basePath = base.pathname.replace(/\/$/, '');

    // 检测 baseUrl 是否已经以任何版本号结尾（v1, v2, v3, v1beta, v1alpha 等）
    // 这样可以兼容火山引擎（/v3）、OpenAI（/v1）、Gemini（/v1beta）等不同版本号
    const anyVersionPattern = /\/v\d+(?:beta|alpha)?$/;
    const hasVersionInBase = anyVersionPattern.test(basePath);

    if (hasVersionInBase) {
      // baseUrl 已包含版本号，只补全端点路径（去掉版本号部分）
      const endpointPath = pathWithVersion.includes('/')
        ? pathWithVersion.split('/').slice(1).join('/')
        : pathWithVersion;
      return new URL(endpointPath, baseUrlWithSlash).toString();
    }

    if (versionPrefix) {
      const versionRe = new RegExp(`/${versionPrefix}$`);
      if (versionRe.test(basePath) && pathWithVersion.startsWith(`${versionPrefix}/`)) {
        const rest = pathWithVersion.slice(versionPrefix.length + 1);
        return new URL(rest, baseUrlWithSlash).toString();
      }
    }

    return new URL(pathWithVersion, baseUrlWithSlash).toString();
  } catch {
    return `${baseUrlWithSlash}${pathWithVersion}`;
  }
}

async function getGitHubProxyToken(): Promise<string | null> {
  const db = getDb();
  const tokenRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('github_token') as { value: string } | undefined;
  if (!tokenRow?.value) return null;
  return decrypt(tokenRow.value, config.encryptionKey);
}

function validateGitHubSearchQueryParams(input: unknown): { ok: true; value?: Record<string, string> } | { ok: false; message: string } {
  if (input === undefined || input === null) {
    return { ok: true };
  }

  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, message: 'query_params must be an object' };
  }

  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const trimmedKey = key.trim();
    if (!trimmedKey) {
      return { ok: false, message: 'query_params contains an empty key' };
    }
    if (typeof value !== 'string') {
      return { ok: false, message: `query_params["${trimmedKey}"] must be a string` };
    }
    if (trimmedKey.length > 100 || value.length > 2000) {
      return { ok: false, message: `query_params["${trimmedKey}"] is too long` };
    }
    output[trimmedKey] = value;
  }

  return { ok: true, value: output };
}

async function proxyGitHubSearch(
  path: 'search/repositories' | 'search/users',
  queryParams: Record<string, string> | undefined,
  res: ExpressResponse,
): Promise<void> {
  let token: string | null;
  try {
    token = await getGitHubProxyToken();
  } catch {
    res.status(500).json({ error: 'Failed to decrypt GitHub token', code: 'GITHUB_TOKEN_DECRYPT_FAILED' });
    return;
  }

  if (!token) {
    res.status(400).json({ error: 'GitHub token not configured', code: 'GITHUB_TOKEN_NOT_CONFIGURED' });
    return;
  }

  const queryString = queryParams ? '?' + new URLSearchParams(queryParams).toString() : '';
  const targetUrl = `https://api.github.com/${path}${queryString}`;
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github.v3+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'GithubStarsManager-Backend',
  };

  const result = await proxyRequest({ url: targetUrl, method: 'GET', headers });
  res.status(result.status).json(result.data);
}

// Register specific search routes before the catch-all GitHub proxy route.
router.post('/api/proxy/github/search/repositories', async (req, res) => {
  try {
    const body = req.body as { query_params?: unknown } | undefined;
    const validation = validateGitHubSearchQueryParams(body?.query_params);
    if (!validation.ok) {
      res.status(400).json({ error: validation.message, code: 'INVALID_QUERY_PARAMS' });
      return;
    }

    await proxyGitHubSearch('search/repositories', validation.value, res);
  } catch (err) {
    console.error('GitHub search repositories proxy error:', err);
    res.status(500).json({ error: 'GitHub search proxy failed', code: 'GITHUB_SEARCH_PROXY_FAILED' });
  }
});

router.post('/api/proxy/github/search/users', async (req, res) => {
  try {
    const body = req.body as { query_params?: unknown } | undefined;
    const validation = validateGitHubSearchQueryParams(body?.query_params);
    if (!validation.ok) {
      res.status(400).json({ error: validation.message, code: 'INVALID_QUERY_PARAMS' });
      return;
    }

    await proxyGitHubSearch('search/users', validation.value, res);
  } catch (err) {
    console.error('GitHub search users proxy error:', err);
    res.status(500).json({ error: 'GitHub search proxy failed', code: 'GITHUB_SEARCH_PROXY_FAILED' });
  }
});

// POST /api/proxy/github/*
router.post('/api/proxy/github/*', async (req, res) => {
  try {
    const db = getDb();
    // 手动解析原始路径，避免 new URL().pathname 将 %2F 解码为 / 后破坏分支名等参数
    const queryIndex = req.url.indexOf('?');
    const rawPath = queryIndex >= 0 ? req.url.substring(0, queryIndex) : req.url;
    const queryString = queryIndex >= 0 ? req.url.substring(queryIndex) : '';
    const githubPath = rawPath.replace(/^\/api\/proxy\/github\//, '');

    // Read and decrypt GitHub token from settings
    const tokenRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('github_token') as { value: string } | undefined;
    if (!tokenRow?.value) {
      res.status(400).json({ error: 'GitHub token not configured', code: 'GITHUB_TOKEN_NOT_CONFIGURED' });
      return;
    }

    let token: string;
    try {
      token = decrypt(tokenRow.value, config.encryptionKey);
    } catch {
      res.status(500).json({ error: 'Failed to decrypt GitHub token', code: 'GITHUB_TOKEN_DECRYPT_FAILED' });
      return;
    }

    // Build target URL with raw path to preserve URL encoding
    const targetUrl = `https://api.github.com/${githubPath}${queryString}`;

    const proxyBody = req.body as { method?: string; headers?: Record<string, string>; body?: unknown };
    const method = proxyBody.method || 'GET';

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Accept': proxyBody.headers?.Accept || 'application/vnd.github.v3+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'GithubStarsManager-Backend',
    };

    const result = await proxyRequest({ url: targetUrl, method, headers, body: proxyBody.body as string | object | undefined });
    res.status(result.status).json(result.data);
  } catch (err) {
    console.error('GitHub proxy error:', err);
    res.status(500).json({ error: 'GitHub proxy failed', code: 'GITHUB_PROXY_FAILED' });
  }
});

// POST /api/proxy/ai
router.post('/api/proxy/ai', async (req, res) => {
  try {
    const db = getDb();
    const { configId, body: requestBody } = req.body as { configId: string; body: Record<string, unknown> };

    if (!configId) {
      res.status(400).json({ error: 'configId required', code: 'CONFIG_ID_REQUIRED' });
      return;
    }

    const aiConfig = db.prepare('SELECT * FROM ai_configs WHERE id = ?').get(configId) as Record<string, unknown> | undefined;
    if (!aiConfig) {
      res.status(404).json({ error: 'AI config not found', code: 'AI_CONFIG_NOT_FOUND' });
      return;
    }

    const apiKey = decrypt(aiConfig.api_key_encrypted as string, config.encryptionKey);
    const apiType = (aiConfig.api_type as string) || 'openai';
    const baseUrl = aiConfig.base_url as string;
    const model = aiConfig.model as string;
    const reasoningEffort = aiConfig.reasoning_effort === 'minimal'
      ? 'low'
      : aiConfig.reasoning_effort as string | null | undefined;

    let targetUrl: string;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };

    if (apiType === 'openai' || apiType === 'openai-responses' || apiType === 'openai-compatible' || apiType === 'deepseek' || apiType === 'mimo') {
      if (apiType === 'openai-compatible') {
        targetUrl = baseUrl.replace(/\/$/, '');
      } else if (apiType === 'deepseek') {
        targetUrl = buildApiUrl(baseUrl, 'v1/chat/completions');
      } else if (apiType === 'mimo') {
        targetUrl = buildApiUrl(baseUrl, 'v1/chat/completions');
      } else {
        targetUrl = buildApiUrl(baseUrl, apiType === 'openai-responses' ? 'v1/responses' : 'v1/chat/completions');
      }
      headers['Authorization'] = `Bearer ${apiKey}`;
    } else if (apiType === 'claude') {
      targetUrl = buildApiUrl(baseUrl, 'v1/messages');
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      // gemini
      const rawModel = model.trim();
      const modelName = rawModel.startsWith('models/') ? rawModel.slice('models/'.length) : rawModel;
      const path = `v1beta/models/${encodeURIComponent(modelName)}:generateContent`;
      targetUrl = buildApiUrl(baseUrl, path);
      const urlObj = new URL(targetUrl);
      urlObj.searchParams.set('key', apiKey);
      targetUrl = urlObj.toString();
    }

    const effectiveRequestBody = (() => {
      const body = requestBody as Record<string, unknown>;
      const isDeepSeekThinking = apiType === 'deepseek' && model.trim() !== 'deepseek-reasoner';
      const isMiMo = apiType === 'mimo';

      let result = { ...body };

      if (
        reasoningEffort
        && typeof body === 'object'
        && body !== null
        && (apiType === 'openai' || apiType === 'openai-responses' || apiType === 'openai-compatible')
        && !('reasoning' in body)
      ) {
        result = { ...result, reasoning: { effort: reasoningEffort } };
      }

      if (isDeepSeekThinking || isMiMo) {
        result = { ...result, thinking: { type: 'disabled' } };
      }

      return result;
    })();

    const timeout = apiType === 'openai-responses' || !!reasoningEffort ? 600000 : 60000;

    const result = await proxyRequest({
      url: targetUrl,
      method: 'POST',
      headers,
      body: effectiveRequestBody,
      timeout,
    });

    res.status(result.status).json(result.data);
  } catch (err) {
    console.error('AI proxy error:', err);
    res.status(500).json({ error: 'AI proxy failed', code: 'AI_PROXY_FAILED' });
  }
});

// POST /api/proxy/webdav
router.post('/api/proxy/webdav', async (req, res) => {
  try {
    const db = getDb();
    const { configId, method, path, body: requestBody, headers: extraHeaders, inlineUrl, inlineUsername, inlinePassword } = req.body as {
      configId: string;
      method: string;
      path: string;
      body?: string;
      headers?: Record<string, string>;
      inlineUrl?: string;
      inlineUsername?: string;
      inlinePassword?: string;
    };

    if (!configId) {
      res.status(400).json({ error: 'configId required', code: 'CONFIG_ID_REQUIRED' });
      return;
    }

    let username: string;
    let password: string;
    let baseUrl: string;

    const webdavConfig = db.prepare('SELECT * FROM webdav_configs WHERE id = ?').get(configId) as Record<string, unknown> | undefined;
    if (webdavConfig) {
      password = decrypt(webdavConfig.password_encrypted as string, config.encryptionKey);
      username = webdavConfig.username as string;
      baseUrl = webdavConfig.url as string;
    } else if (
      typeof inlineUrl === 'string' && inlineUrl.trim() &&
      typeof inlineUsername === 'string' &&
      typeof inlinePassword === 'string'
    ) {
      // 新配置尚未同步到 DB，使用前端传入的凭据直连
      baseUrl = inlineUrl.trim();
      username = inlineUsername;
      password = inlinePassword;
    } else {
      res.status(404).json({ error: 'WebDAV config not found', code: 'WEBDAV_CONFIG_NOT_FOUND' });
      return;
    }

    const targetUrl = `${baseUrl}${path}`;
    const credentials = Buffer.from(`${username}:${password}`).toString('base64');

    const { Authorization: _authorization, ...safeHeaders } = extraHeaders || {};
    void _authorization;
    const headers: Record<string, string> = {
      ...safeHeaders,
      'Authorization': `Basic ${credentials}`,
    };

    if (method === 'PROPFIND') {
      headers['Content-Type'] = headers['Content-Type'] || 'application/xml';
    }

    const result = await proxyRequest({
      url: targetUrl,
      method,
      headers,
      body: requestBody,
      timeout: 60000,
    });

    res.status(result.status).json(result.data);
  } catch (err) {
    console.error('WebDAV proxy error:', err);
    res.status(500).json({ error: 'WebDAV proxy failed', code: 'WEBDAV_PROXY_FAILED' });
  }
});

// === Network Proxy Config ===

router.get('/api/settings/proxy', (req, res) => {
  try {
    const db = getDb();
    const row = db.prepare("SELECT value FROM settings WHERE key = 'proxy_config'").get() as { value: string } | undefined;
    if (!row?.value) {
      res.json({ enabled: false, type: 'http', host: '', port: 8080 });
      return;
    }
    const parsed = JSON.parse(row.value);
    res.json({ ...parsed, password: undefined });
  } catch (err) {
    console.error('GET proxy config error:', err);
    res.status(500).json({ error: 'Failed to load proxy config' });
  }
});

router.post('/api/settings/proxy', (req, res) => {
  try {
    const db = getDb();
    const { enabled, type, host, port, username, password } = req.body as Record<string, unknown>;
    const proxyConfig = { enabled: !!enabled, type: type || 'http', host: host || '', port: port || 8080, username: username || '', password: password || '' };
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('proxy_config', ?)").run(JSON.stringify(proxyConfig));
    res.json({ saved: true });
  } catch (err) {
    console.error('POST proxy config error:', err);
    res.status(500).json({ error: 'Failed to save proxy config' });
  }
});

router.post('/api/settings/proxy/test', async (req, res) => {
  try {
    const { host, port } = req.body as { host?: string; port?: number; type?: string };
    if (!host || !port) {
      res.json({ success: false, error: 'Host and port are required' });
      return;
    }

    const socket = new net.Socket();
    const timeoutMs = 5000;

    const result = await new Promise<{ success: boolean; error?: string }>((resolve) => {
      const timer = setTimeout(() => {
        socket.destroy();
        resolve({ success: false, error: `Connection timeout (${timeoutMs / 1000}s)` });
      }, timeoutMs);

      socket.on('connect', () => {
        clearTimeout(timer);
        socket.destroy();
        resolve({ success: true });
      });

      socket.on('error', (err) => {
        clearTimeout(timer);
        resolve({ success: false, error: err.message });
      });

      socket.connect(port, host);
    });

    res.json(result);
  } catch (err) {
    console.error('Proxy test error:', err);
    res.json({ success: false, error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

// === Microsoft Translator Proxy ===

// MS auth token 在进程内存中缓存
let msTranslateToken: string | null = null;
let msTranslateTokenExpiresAt = 0;
const MS_AUTH_URL = 'https://edge.microsoft.com/translate/auth';
const MS_TRANSLATE_URL = 'https://api-edge.cognitive.microsofttranslator.com/translate';

async function getMsTranslateToken(): Promise<string> {
  const now = Date.now();
  const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

  if (msTranslateToken && now < msTranslateTokenExpiresAt - TOKEN_REFRESH_BUFFER_MS) {
    return msTranslateToken;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  let res: Response;
  try {
    res = await fetch(MS_AUTH_URL, { method: 'GET', signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
  if (!res.ok) throw new Error(`MS auth failed: ${res.status}`);
  const token = await res.text();

  // 解析 JWT 获取过期时间
  try {
    const parts = token.split('.');
    if (parts.length === 3) {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
      if (payload.exp) {
        msTranslateTokenExpiresAt = payload.exp * 1000;
      }
    }
  } catch { /* 解析失败则用默认 8 分钟 */ }

  if (msTranslateTokenExpiresAt <= now) {
    msTranslateTokenExpiresAt = now + 8 * 60 * 1000;
  }

  msTranslateToken = token;
  return token;
}

router.post('/api/proxy/translate', async (req, res) => {
  try {
    const { texts, to, from, textType } = req.body as {
      texts: string[];
      to: string;
      from?: string;
      textType?: string;
    };

    if (!texts || !Array.isArray(texts) || texts.length === 0 || !to) {
      res.status(400).json({ error: 'texts and to are required', code: 'TRANSLATE_PARAMS_REQUIRED' });
      return;
    }

    const token = await getMsTranslateToken();

    const params = new URLSearchParams({ 'api-version': '3.0', to });
    if (from) params.set('from', from);
    if (textType === 'html') params.set('textType', 'html');

    const targetUrl = `${MS_TRANSLATE_URL}?${params.toString()}`;

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    const body = texts.map(t => ({ Text: t }));

    const result = await proxyRequest({ url: targetUrl, method: 'POST', headers, body });

    if (result.status === 401) {
      // Token 过期，清除缓存后重试一次
      msTranslateToken = null;
      msTranslateTokenExpiresAt = 0;
      const newToken = await getMsTranslateToken();
      headers['Authorization'] = `Bearer ${newToken}`;
      const retryResult = await proxyRequest({ url: targetUrl, method: 'POST', headers, body });
      res.status(retryResult.status).json(retryResult.data);
      return;
    }

    res.status(result.status).json(result.data);
  } catch (err) {
    console.error('Translation proxy error:', err);
    res.status(500).json({ error: 'Translation proxy failed', code: 'TRANSLATION_PROXY_FAILED' });
  }
});

export default router;
