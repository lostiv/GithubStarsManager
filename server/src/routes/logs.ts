import { Router } from 'express';
import { logger, LogLevel } from '../services/logger.js';

const router = Router();
const ALLOWED_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];
const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 2000;

function parseLimit(rawLimit: unknown): number | null {
  if (rawLimit === undefined) return DEFAULT_LIMIT;
  if (typeof rawLimit !== 'string' || !/^\d+$/.test(rawLimit)) return null;
  const limit = Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return null;
  return limit;
}

router.get('/api/logs', (req, res) => {
  try {
    const limit = parseLimit(req.query.limit);
    if (limit === null) {
      res.status(400).json({ error: 'Invalid limit', code: 'INVALID_LIMIT' });
      return;
    }

    const rawLevel = typeof req.query.level === 'string' ? req.query.level : undefined;
    if (rawLevel && !ALLOWED_LEVELS.includes(rawLevel as LogLevel)) {
      res.status(400).json({ error: 'Invalid log level', code: 'INVALID_LOG_LEVEL' });
      return;
    }

    const rawSince = typeof req.query.since === 'string' ? req.query.since : undefined;
    if (rawSince && Number.isNaN(Date.parse(rawSince))) {
      res.status(400).json({ error: 'Invalid since value', code: 'INVALID_SINCE' });
      return;
    }

    const entries = logger.getEntries({ level: rawLevel as LogLevel | undefined, since: rawSince });
    res.setHeader('X-Log-Count', String(entries.length));
    res.json(entries.slice(-limit));
  } catch (err) {
    logger.errorFromError('logs.route', 'Failed to fetch logs', err);
    res.status(500).json({ error: 'Failed to fetch logs', code: 'FETCH_LOGS_FAILED' });
  }
});

router.get('/api/logs/debug', (_req, res) => {
  res.json({ debugMode: logger.isDebugMode() });
});

router.post('/api/logs/debug', (req, res) => {
  try {
    if (typeof req.body?.enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be a boolean', code: 'INVALID_DEBUG_ENABLED' });
      return;
    }

    const enabled = req.body.enabled;
    logger.setLevel(enabled ? 'debug' : 'info');
    logger.info('logs.debug', enabled ? 'Backend debug mode enabled' : 'Backend debug mode disabled');
    res.json({ success: true, debugMode: logger.isDebugMode() });
  } catch (err) {
    logger.errorFromError('logs.route', 'Failed to toggle backend debug mode', err);
    res.status(500).json({ error: 'Failed to toggle debug mode', code: 'DEBUG_TOGGLE_FAILED' });
  }
});

router.delete('/api/logs', (_req, res) => {
  try {
    logger.clear();
    res.json({ success: true });
  } catch (err) {
    logger.errorFromError('logs.route', 'Failed to clear logs', err);
    res.status(500).json({ error: 'Failed to clear logs', code: 'CLEAR_LOGS_FAILED' });
  }
});

export default router;
