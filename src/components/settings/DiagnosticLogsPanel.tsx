import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Download,
  Loader2,
  RefreshCw,
  ScrollText,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { backend } from '../../services/backendAdapter';
import { logger, LogEntry, LogLevel } from '../../services/logger';
import { useAppStore } from '../../store/useAppStore';
import { EVENT_TYPE_LABELS, inferEventType, LogEventType } from '../../utils/logEventTypes';
import { maskUrlDomain } from '../../utils/logSanitizer';

interface DiagnosticLogsPanelProps {
  t: (zh: string, en: string) => string;
}

const LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];
const PAGE_SIZE = 100;

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: 'bg-gray-100 text-gray-600 dark:bg-white/[0.06] dark:text-gray-400',
  info: 'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-400',
  warn: 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-400',
  error: 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-400',
};

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return `${Math.max(0, Math.floor(diff / 1000))}s`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

function toPrettyJson(data: unknown): string {
  if (typeof data === 'string') return data;
  return JSON.stringify(data, null, 2);
}

function getStatusColor(status: unknown): string {
  const prefix = String(status ?? '').charAt(0);
  if (prefix === '2') return 'text-green-600 dark:text-green-400';
  if (prefix === '4') return 'text-amber-600 dark:text-amber-400';
  if (prefix === '5') return 'text-red-600 dark:text-red-400';
  return '';
}

export const DiagnosticLogsPanel: React.FC<DiagnosticLogsPanelProps> = ({ t }) => {
  const language = useAppStore((state) => state.language);
  const backendApiSecret = useAppStore((state) => state.backendApiSecret);

  const [frontendDebug, setFrontendDebug] = useState(() => {
    const enabled = sessionStorage.getItem('gsm:frontend-debug') === 'true';
    if (enabled) logger.setLevel('debug');
    return enabled;
  });
  const [backendDebug, setBackendDebug] = useState(false);
  const [frontendEntries, setFrontendEntries] = useState<LogEntry[]>(() => logger.getEntries());
  const [backendEntries, setBackendEntries] = useState<LogEntry[]>([]);
  const [backendLogCount, setBackendLogCount] = useState(0);
  const [selectedLevels, setSelectedLevels] = useState<Set<LogLevel>>(new Set(['info', 'warn', 'error']));
  const [selectedScope, setSelectedScope] = useState<'all' | 'frontend' | 'backend'>('all');
  const [selectedEventTypes, setSelectedEventTypes] = useState<Set<LogEventType>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [detailEntry, setDetailEntry] = useState<LogEntry | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [backendAvailable, setBackendAvailable] = useState(() => backend.isAvailable);

  const getAuthHeaders = useCallback((): HeadersInit => {
    const headers: Record<string, string> = {};
    if (backendApiSecret) {
      headers.Authorization = `Bearer ${backendApiSecret}`;
    }
    return headers;
  }, [backendApiSecret]);

  const backendApiUrl = useCallback((path: string): string => {
    return `${backend.backendUrl ?? `${window.location.origin}/api`}${path}`;
  }, []);

  useEffect(() => {
    const syncBackendAvailability = () => setBackendAvailable(backend.isAvailable);
    syncBackendAvailability();
    const interval = window.setInterval(syncBackendAvailability, 2000);
    return () => window.clearInterval(interval);
  }, []);

  const refreshBackendLogs = useCallback(async () => {
    if (!backendAvailable) {
      setBackendEntries([]);
      setBackendLogCount(0);
      return;
    }

    setIsRefreshing(true);
    try {
      const response = await fetch(backendApiUrl('/logs?limit=2000'), {
        headers: getAuthHeaders(),
      });
      if (!response.ok) {
        throw new Error(`Fetch logs failed: ${response.status}`);
      }
      const raw = await response.json();
      const logs = Array.isArray(raw) ? raw as LogEntry[] : [];
      setBackendEntries(logs);
      const totalHeader = response.headers.get('X-Log-Count');
      setBackendLogCount(totalHeader ? parseInt(totalHeader, 10) || logs.length : logs.length);
    } catch (err) {
      logger.errorFromError('diagnosticLogs', 'Failed to fetch backend logs', err);
    } finally {
      setIsRefreshing(false);
    }
  }, [backendApiUrl, backendAvailable, getAuthHeaders]);

  useEffect(() => {
    const onLogAdded = (event: Event) => {
      const entry = (event as CustomEvent<LogEntry>).detail;
      if (!entry) return;
      setFrontendEntries((previous) => {
        const next = [...previous, entry];
        return next.length > 2000 ? next.slice(-2000) : next;
      });
    };
    const onLogsCleared = () => setFrontendEntries([]);

    window.addEventListener('gsm:diagnostic-log-added', onLogAdded);
    window.addEventListener('gsm:diagnostic-logs-cleared', onLogsCleared);
    return () => {
      window.removeEventListener('gsm:diagnostic-log-added', onLogAdded);
      window.removeEventListener('gsm:diagnostic-logs-cleared', onLogsCleared);
    };
  }, []);

  useEffect(() => {
    if (!backendAvailable) return;

    const fetchDebugState = async () => {
      try {
        const response = await fetch(backendApiUrl('/logs/debug'), {
          headers: getAuthHeaders(),
        });
        if (!response.ok) return;
        const data = await response.json() as { debugMode?: boolean };
        setBackendDebug(data.debugMode === true);
        sessionStorage.setItem('gsm:backend-debug', String(data.debugMode === true));
      } catch {
        setBackendDebug(false);
      }
    };

    void fetchDebugState();
  }, [backendApiUrl, backendAvailable, getAuthHeaders]);

  useEffect(() => {
    if (selectedScope === 'frontend') {
      setBackendEntries([]);
      setBackendLogCount(0);
      return;
    }

    void refreshBackendLogs();
    const interval = window.setInterval(() => void refreshBackendLogs(), 10_000);
    return () => window.clearInterval(interval);
  }, [refreshBackendLogs, selectedScope]);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [searchQuery, selectedLevels, selectedEventTypes, selectedScope]);

  const allEntries = useMemo(() => {
    const entries =
      selectedScope === 'frontend'
        ? frontendEntries
        : selectedScope === 'backend'
          ? backendEntries
          : [...frontendEntries, ...backendEntries];

    return [...entries].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }, [backendEntries, frontendEntries, selectedScope]);

  const availableEventTypes = useMemo(() => {
    const types = new Set<LogEventType>();
    for (const entry of allEntries) {
      types.add(inferEventType(entry.module, entry.message, entry.data));
    }
    return Array.from(types).sort();
  }, [allEntries]);

  const filteredEntries = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return allEntries.filter((entry) => {
      if (!selectedLevels.has(entry.level)) return false;
      const eventType = inferEventType(entry.module, entry.message, entry.data);
      if (selectedEventTypes.size > 0 && !selectedEventTypes.has(eventType)) return false;
      if (!query) return true;
      return entry.module.toLowerCase().includes(query) || entry.message.toLowerCase().includes(query);
    });
  }, [allEntries, searchQuery, selectedEventTypes, selectedLevels]);

  const visibleEntries = filteredEntries.slice(0, visibleCount);
  const frontendCounts = logger.getCounts();

  const toggleFrontendDebug = useCallback(() => {
    const next = !frontendDebug;
    setFrontendDebug(next);
    logger.setLevel(next ? 'debug' : 'info');
    sessionStorage.setItem('gsm:frontend-debug', String(next));
    if (next) {
      setSelectedLevels((previous) => new Set([...previous, 'debug']));
    }
  }, [frontendDebug]);

  const toggleBackendDebug = useCallback(async () => {
    if (!backendAvailable) return;
    const next = !backendDebug;

    try {
      const response = await fetch(backendApiUrl('/logs/debug'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders(),
        },
        body: JSON.stringify({ enabled: next }),
      });
      if (!response.ok) {
        throw new Error(`Toggle backend debug failed: ${response.status}`);
      }
      const data = await response.json() as { debugMode?: boolean };
      setBackendDebug(data.debugMode === true);
      sessionStorage.setItem('gsm:backend-debug', String(data.debugMode === true));
      if (data.debugMode) {
        setSelectedLevels((previous) => new Set([...previous, 'debug']));
      }
      await refreshBackendLogs();
    } catch (err) {
      logger.errorFromError('diagnosticLogs', 'Failed to toggle backend debug mode', err);
    }
  }, [backendApiUrl, backendAvailable, backendDebug, getAuthHeaders, refreshBackendLogs]);

  const handleClear = useCallback(async () => {
    if (selectedScope !== 'backend') {
      logger.clear();
      setFrontendEntries([]);
    }

    if (selectedScope !== 'frontend' && backendAvailable) {
      try {
        const response = await fetch(backendApiUrl('/logs'), {
          method: 'DELETE',
          headers: getAuthHeaders(),
        });
        if (!response.ok) {
          throw new Error(`Clear backend logs failed: ${response.status}`);
        }
        setBackendEntries([]);
        setBackendLogCount(0);
      } catch (err) {
        logger.errorFromError('diagnosticLogs', 'Failed to clear backend logs', err);
      }
    }
  }, [backendApiUrl, backendAvailable, getAuthHeaders, selectedScope]);

  const handleExport = useCallback(async () => {
    setIsExporting(true);
    try {
      const exportData = {
        format: 'github-stars-manager-logs-v1',
        exportedAt: new Date().toISOString(),
        environment: {
          backendAvailable,
          backendUrl: backendAvailable ? maskUrlDomain(backend.backendUrl ?? '') : null,
          language,
          frontendDebug,
          backendDebug,
        },
        logs: filteredEntries,
      };
      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `github-stars-manager-logs-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } finally {
      setIsExporting(false);
    }
  }, [backendAvailable, backendDebug, filteredEntries, frontendDebug, language]);

  const toggleLevel = (level: LogLevel) => {
    setSelectedLevels((previous) => {
      const next = new Set(previous);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  };

  const toggleEventType = (eventType: LogEventType) => {
    setSelectedEventTypes((previous) => {
      const next = new Set(previous);
      if (next.has(eventType)) next.delete(eventType);
      else next.add(eventType);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      {detailEntry && (
        <LogDetailModal entry={detailEntry} onClose={() => setDetailEntry(null)} t={t} />
      )}

      <section className="bg-white dark:bg-panel-dark rounded-lg border border-black/[0.06] dark:border-white/[0.04] p-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-text-primary flex items-center">
            <ScrollText className="w-5 h-5 mr-2 text-gray-700 dark:text-text-secondary" />
            {t('诊断日志', 'Diagnostic Logs')}
          </h3>
          <div className="flex items-center gap-2">
            <button
              onClick={toggleFrontendDebug}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                frontendDebug
                  ? 'bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-400'
                  : 'bg-gray-100 text-gray-700 dark:bg-white/[0.04] dark:text-text-secondary'
              }`}
            >
              {t('前端调试', 'Frontend Debug')}: {frontendDebug ? 'ON' : 'OFF'}
            </button>
            <button
              onClick={toggleBackendDebug}
              disabled={!backendAvailable}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                backendDebug
                  ? 'bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-400'
                  : 'bg-gray-100 text-gray-700 dark:bg-white/[0.04] dark:text-text-secondary'
              }`}
            >
              {t('后端调试', 'Backend Debug')}: {backendAvailable ? (backendDebug ? 'ON' : 'OFF') : t('未连接', 'Offline')}
            </button>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-2 text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-500/10 p-2 rounded-lg">
          <ShieldCheck className="w-4 h-4 shrink-0" />
          <span>{t('日志会在写入时脱敏 Token、API Key、密码和邮箱。', 'Logs are sanitized when written: tokens, API keys, passwords, and emails are masked.')}</span>
        </div>
      </section>

      <section className="bg-white dark:bg-panel-dark rounded-lg border border-black/[0.06] dark:border-white/[0.04] p-4 space-y-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={t('搜索模块或消息...', 'Search module or message...')}
            className="w-full pl-10 pr-4 py-2 rounded-lg border border-black/[0.06] dark:border-white/[0.04] bg-light-surface dark:bg-white/[0.04] text-gray-900 dark:text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-brand-violet"
          />
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {LEVELS.map((level) => (
            <button
              key={level}
              onClick={() => toggleLevel(level)}
              aria-pressed={selectedLevels.has(level)}
              className={`px-3 py-1 text-sm rounded-full border transition-colors flex items-center gap-1 ${
                selectedLevels.has(level)
                  ? LEVEL_COLORS[level]
                  : 'border-gray-200 dark:border-white/[0.06] text-gray-500 dark:text-text-tertiary bg-transparent'
              }`}
            >
              {selectedLevels.has(level) && <Check className="w-3 h-3" />}
              <span>{level}</span>
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {(['all', 'frontend', 'backend'] as const).map((scope) => (
            <button
              key={scope}
              onClick={() => setSelectedScope(scope)}
              disabled={scope === 'backend' && !backendAvailable}
              className={`px-3 py-1.5 text-sm rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                selectedScope === scope
                  ? 'bg-brand-indigo text-white'
                  : 'bg-gray-100 text-gray-700 dark:bg-white/[0.04] dark:text-text-secondary hover:bg-gray-200 dark:hover:bg-white/[0.08]'
              }`}
            >
              {scope === 'all' ? t('全部', 'All') : scope === 'frontend' ? t('前端', 'Frontend') : t('后端', 'Backend')}
            </button>
          ))}

          <div className="flex items-center gap-2 flex-wrap">
            {availableEventTypes.map((eventType) => (
              <button
                key={eventType}
                onClick={() => toggleEventType(eventType)}
                aria-pressed={selectedEventTypes.has(eventType)}
                className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
                  selectedEventTypes.has(eventType)
                    ? 'bg-brand-indigo/10 text-brand-indigo dark:bg-brand-violet/20 dark:text-brand-violet'
                    : 'bg-gray-100 text-gray-700 dark:bg-white/[0.04] dark:text-text-secondary hover:bg-gray-200 dark:hover:bg-white/[0.08]'
                }`}
              >
                {language === 'zh' ? EVENT_TYPE_LABELS[eventType].zh : EVENT_TYPE_LABELS[eventType].en}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2 ml-auto">
            <button
              onClick={() => void refreshBackendLogs()}
              disabled={!backendAvailable || isRefreshing}
              className="p-2 rounded-lg text-gray-600 dark:text-text-secondary hover:bg-gray-100 dark:hover:bg-white/[0.06] transition-colors disabled:opacity-50"
              title={t('刷新', 'Refresh')}
            >
              <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={() => void handleClear()}
              className="p-2 rounded-lg text-gray-600 dark:text-text-secondary hover:bg-gray-100 dark:hover:bg-white/[0.06] transition-colors"
              title={t('清空', 'Clear')}
            >
              <Trash2 className="w-4 h-4" />
            </button>
            <button
              onClick={() => void handleExport()}
              disabled={isExporting}
              className="px-3 py-1.5 text-sm font-medium rounded-lg bg-brand-indigo hover:bg-brand-hover text-white transition-colors disabled:opacity-50 flex items-center gap-1"
            >
              {isExporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              <span>{t('导出', 'Export')}</span>
            </button>
          </div>
        </div>

        <div className="text-xs text-gray-500 dark:text-text-tertiary">
          {t(`显示 ${filteredEntries.length} / ${allEntries.length} 条`, `Showing ${filteredEntries.length} / ${allEntries.length} entries`)}
          <span className="ml-2">{t(`前端 ${frontendCounts.total}`, `Frontend ${frontendCounts.total}`)}</span>
          {backendAvailable && <span className="ml-2">{t(`后端 ${backendLogCount}`, `Backend ${backendLogCount}`)}</span>}
        </div>
      </section>

      <section className="bg-white dark:bg-panel-dark rounded-lg border border-black/[0.06] dark:border-white/[0.04] overflow-hidden">
        {filteredEntries.length === 0 ? (
          <div className="p-8 text-center text-gray-400 dark:text-text-quaternary">
            <ScrollText className="w-8 h-8 mx-auto mb-2 opacity-50" />
            {allEntries.length === 0 ? t('暂无日志', 'No logs yet') : t('无匹配日志', 'No matching logs')}
          </div>
        ) : (
          <>
            <div className="max-h-[560px] overflow-y-auto divide-y divide-black/[0.04] dark:divide-white/[0.02]">
              {visibleEntries.map((entry) => {
                const eventType = inferEventType(entry.module, entry.message, entry.data);
                const data = entry.data as Record<string, unknown> | undefined;
                const hasDetail = data !== undefined;
                return (
                  <button
                    key={entry.id}
                    onClick={() => hasDetail && setDetailEntry(entry)}
                    className={`w-full text-left px-4 py-3 transition-colors ${
                      hasDetail ? 'hover:bg-light-surface dark:hover:bg-white/[0.02]' : ''
                    }`}
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${LEVEL_COLORS[entry.level]}`}>
                        {entry.level}
                      </span>
                      <span className={`px-2 py-0.5 text-xs rounded-full ${
                        entry.source === 'frontend'
                          ? 'bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-400'
                          : 'bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-400'
                      }`}>
                        {entry.source === 'frontend' ? 'FE' : 'BE'}
                      </span>
                      <span className="px-2 py-0.5 text-xs rounded-full bg-gray-100 text-gray-600 dark:bg-white/[0.06] dark:text-gray-400">
                        {language === 'zh' ? EVENT_TYPE_LABELS[eventType].zh : EVENT_TYPE_LABELS[eventType].en}
                      </span>
                      <span className="text-xs text-gray-500 dark:text-text-tertiary" title={entry.timestamp}>
                        {formatRelativeTime(entry.timestamp)}
                      </span>
                      <span className="px-1.5 py-0.5 text-xs bg-brand-indigo/10 text-brand-indigo dark:bg-brand-violet/20 dark:text-brand-violet rounded font-mono">
                        {entry.module}
                      </span>
                    </div>
                    <p className="text-sm text-gray-900 dark:text-text-primary mt-1 break-words">
                      {entry.message}
                    </p>
                    {data && (
                      <div className="text-xs mt-1 font-mono flex items-center gap-1 text-gray-500 dark:text-text-tertiary overflow-hidden">
                        {data.method && <span className="font-bold">{String(data.method)}</span>}
                        {(data.endpoint || data.path || data.url) && (
                          <span className="truncate">{String(data.endpoint ?? data.path ?? data.url)}</span>
                        )}
                        {data.status && <span className={`font-bold ${getStatusColor(data.status)}`}>→ {String(data.status)}</span>}
                        {data.durationMs != null && <span className="text-blue-600 dark:text-blue-400">{String(data.durationMs)}ms</span>}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
            {visibleCount < filteredEntries.length && (
              <div className="p-3 text-center border-t border-black/[0.04] dark:border-white/[0.02]">
                <button
                  onClick={() => setVisibleCount((previous) => previous + PAGE_SIZE)}
                  className="text-sm text-brand-indigo hover:text-brand-hover transition-colors"
                >
                  {t(`加载更多（还有 ${filteredEntries.length - visibleCount} 条）`, `Load more (${filteredEntries.length - visibleCount} remaining)`)}
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
};

const LogDetailModal: React.FC<{
  entry: LogEntry;
  onClose: () => void;
  t: (zh: string, en: string) => string;
}> = ({ entry, onClose, t }) => {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-3xl max-h-[80vh] bg-white dark:bg-panel-dark rounded-lg shadow-2xl overflow-hidden flex flex-col"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-black/[0.06] dark:border-white/[0.04]">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${LEVEL_COLORS[entry.level]}`}>{entry.level}</span>
              <span className="text-xs text-gray-500 dark:text-text-tertiary font-mono">{entry.module}</span>
            </div>
            <h4 className="mt-1 font-medium text-gray-900 dark:text-text-primary truncate">{entry.message}</h4>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-white/[0.06] transition-colors shrink-0 ml-2"
            aria-label={t('关闭', 'Close')}
          >
            <X className="w-5 h-5 text-gray-500 dark:text-text-tertiary" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            <DetailRow label={t('来源', 'Source')} value={entry.source} />
            <DetailRow label={t('时间', 'Timestamp')} value={entry.timestamp} />
            <DetailRow label={t('级别', 'Level')} value={entry.level} />
            <DetailRow label={t('模块', 'Module')} value={entry.module} />
          </div>
          {entry.data !== undefined ? (
            <pre className="text-xs bg-gray-50 dark:bg-white/[0.02] rounded-lg p-3 overflow-auto max-h-[420px] font-mono text-gray-700 dark:text-text-secondary whitespace-pre-wrap break-all">
              {toPrettyJson(entry.data)}
            </pre>
          ) : (
            <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-text-tertiary">
              <AlertTriangle className="w-4 h-4" />
              <span>{t('此日志没有附加数据。', 'This log has no attached data.')}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const DetailRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div>
    <div className="text-xs text-gray-500 dark:text-text-tertiary">{label}</div>
    <div className="font-mono text-xs text-gray-900 dark:text-text-primary break-all">{value}</div>
  </div>
);
