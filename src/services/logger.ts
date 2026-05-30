import { sanitizeError, sanitizeForLog } from '../utils/logSanitizer';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  module: string;
  message: string;
  data?: unknown;
  source: 'frontend' | 'backend';
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
      source: 'frontend',
    };

    this.buffer.push(entry);
    if (this.buffer.length > this.maxEntries) {
      this.buffer.shift();
    }

    this.forwardToConsole(entry);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('gsm:diagnostic-log-added', { detail: entry }));
    }
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

  getEntries(filter?: { level?: LogLevel; since?: string; module?: string }): LogEntry[] {
    let entries = this.buffer.slice();
    if (filter?.level) {
      const minOrder = LEVEL_ORDER[filter.level];
      entries = entries.filter((entry) => LEVEL_ORDER[entry.level] >= minOrder);
    }
    if (filter?.since) {
      const sinceTime = Date.parse(filter.since);
      if (!Number.isNaN(sinceTime)) {
        entries = entries.filter((entry) => {
          const entryTime = Date.parse(entry.timestamp);
          return !Number.isNaN(entryTime) && entryTime >= sinceTime;
        });
      }
    }
    if (filter?.module) {
      entries = entries.filter((entry) => entry.module.startsWith(filter.module!));
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
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('gsm:diagnostic-logs-cleared'));
    }
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
