import { sanitizeError, sanitizeForLog } from './logSanitizer.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  module: string;
  message: string;
  data?: unknown;
  source: 'backend';
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

class Logger {
  private buffer: LogEntry[] = [];
  private maxEntries = 2000;
  private minLevel: LogLevel = 'info';

  log(level: LogLevel, module: string, message: string, data?: unknown): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;

    const entry: LogEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      level,
      module,
      message: sanitizeForLog(message) as string,
      data: data === undefined ? undefined : sanitizeForLog(data),
      source: 'backend',
    };

    this.buffer.push(entry);
    if (this.buffer.length > this.maxEntries) {
      this.buffer.shift();
    }

    this.forwardToConsole(entry);
  }

  debug(module: string, message: string, data?: unknown): void {
    this.log('debug', module, message, data);
  }

  info(module: string, message: string, data?: unknown): void {
    this.log('info', module, message, data);
  }

  warn(module: string, message: string, data?: unknown): void {
    this.log('warn', module, message, data);
  }

  error(module: string, message: string, data?: unknown): void {
    this.log('error', module, message, data);
  }

  errorFromError(module: string, message: string, err: unknown, extra?: unknown): void {
    const sanitizedExtra = extra !== undefined && typeof extra === 'object' && extra !== null && !Array.isArray(extra)
      ? sanitizeForLog(extra) as Record<string, unknown>
      : extra !== undefined
        ? { extra: sanitizeForLog(extra) }
        : {};
    this.error(module, message, { ...sanitizeError(err), ...sanitizedExtra });
  }

  getEntries(filter?: { level?: LogLevel; since?: string; limit?: number }): LogEntry[] {
    let entries = this.buffer;
    if (filter?.level) {
      const minOrder = LEVEL_ORDER[filter.level];
      entries = entries.filter((entry) => LEVEL_ORDER[entry.level] >= minOrder);
    }
    if (filter?.since) {
      entries = entries.filter((entry) => entry.timestamp >= filter.since!);
    }
    if (filter?.limit && filter.limit > 0) {
      entries = entries.slice(-filter.limit);
    }
    return entries;
  }

  getCounts(): Record<LogLevel | 'total', number> {
    const counts = { total: this.buffer.length, debug: 0, info: 0, warn: 0, error: 0 };
    for (const entry of this.buffer) {
      counts[entry.level]++;
    }
    return counts;
  }

  clear(): void {
    this.buffer = [];
  }

  setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  isDebugMode(): boolean {
    return this.minLevel === 'debug';
  }

  private forwardToConsole(entry: LogEntry): void {
    const prefix = `[${entry.module}]`;
    const data = entry.data ?? '';
    if (entry.level === 'debug') console.debug(prefix, entry.message, data);
    if (entry.level === 'info') console.info(prefix, entry.message, data);
    if (entry.level === 'warn') console.warn(prefix, entry.message, data);
    if (entry.level === 'error') console.error(prefix, entry.message, data);
  }
}

export const logger = new Logger();

export const morganLoggerStream = {
  write(line: string): void {
    const trimmed = line.trim();
    if (trimmed) {
      logger.debug('http.access', trimmed);
    }
  },
};
