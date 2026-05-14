import React, { useState, useEffect } from 'react';
import { Globe, Package, Mail, ExternalLink, Github, Twitter, Clock, RotateCw, AlertCircle, CheckCircle2 } from 'lucide-react';
import { UpdateChecker } from '../UpdateChecker';
import { useAppStore } from '../../store/useAppStore';
import { version } from '../../../package.json';
import { PROJECT_REPO_URL } from '../../constants/project';
import { backend } from '../../services/backendAdapter';
import { useDialog } from '../../hooks/useDialog';

interface GeneralPanelProps {
  t: (zh: string, en: string) => string;
}

export const GeneralPanel: React.FC<GeneralPanelProps> = ({ t }) => {
  const { language, setLanguage } = useAppStore();
  const { toast } = useDialog();

  // Auto-sync state
  const [syncLoading, setSyncLoading] = useState(true);
  const [syncSaving, setSyncSaving] = useState(false);
  const [enabledRepos, setEnabledRepos] = useState(false);
  const [enabledForks, setEnabledForks] = useState(false);
  const [enabledReleases, setEnabledReleases] = useState(false);
  const [intervalHours, setIntervalHours] = useState(24);
  const [intervalMinutes, setIntervalMinutes] = useState(0);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [nextSync, setNextSync] = useState<string | null>(null);
  const [syncEnabled, setSyncEnabled] = useState(false);
  const [syncIsSyncing, setSyncIsSyncing] = useState(false);
  const [githubTokenConfigured, setGithubTokenConfigured] = useState(false);

  useEffect(() => {
    loadSyncSettings();
    loadSyncStatus();
  }, []);

  const loadSyncSettings = async () => {
    try {
      if (!backend.isAvailable) { setSyncLoading(false); return; }
      const s = await backend.fetchAutoSyncSettings();
      setEnabledRepos(s.auto_sync_enabled_repos);
      setEnabledForks(s.auto_sync_enabled_forks);
      setEnabledReleases(s.auto_sync_enabled_releases);
      const hours = Math.floor(s.auto_sync_interval_minutes / 60);
      const mins = s.auto_sync_interval_minutes % 60;
      setIntervalHours(hours);
      setIntervalMinutes(mins);
    } catch {
      // silent fail
    } finally {
      setSyncLoading(false);
    }
  };

  const loadSyncStatus = async () => {
    try {
      if (!backend.isAvailable) return;
      const status = await backend.fetchAutoSyncStatus();
      setLastSync(status.lastSyncTime);
      setNextSync(status.nextScheduledTime);
      setSyncEnabled(status.isEnabled);
      setSyncIsSyncing(status.isSyncing);
      setGithubTokenConfigured(status.githubTokenConfigured);
    } catch {
      // silent fail
    }
  };

  const handleSyncSave = async () => {
    const totalMinutes = intervalHours * 60 + intervalMinutes;
    if (totalMinutes < 1) {
      toast(t('间隔时间至少为1分钟', 'Interval must be at least 1 minute'), 'error');
      return;
    }
    if (!githubTokenConfigured && (enabledRepos || enabledForks || enabledReleases)) {
      toast(t('请先在设置中配置 GitHub Token', 'Please configure GitHub Token in settings first'), 'error');
      return;
    }
    setSyncSaving(true);
    try {
      await backend.updateAutoSyncSettings({
        auto_sync_enabled_repos: enabledRepos,
        auto_sync_enabled_forks: enabledForks,
        auto_sync_enabled_releases: enabledReleases,
        auto_sync_interval_minutes: totalMinutes,
      });
      await loadSyncStatus();
      toast(t('自动同步设置已保存', 'Auto sync settings saved'), 'success');
    } catch (err) {
      toast(
        t(`保存失败: ${err instanceof Error ? err.message : '未知错误'}`, `Failed to save: ${err instanceof Error ? err.message : 'Unknown error'}`),
        'error'
      );
    } finally {
      setSyncSaving(false);
    }
  };

  const formatTime = (iso: string | null): string => {
    if (!iso) return t('暂无', 'None');
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center space-x-3">
        <Package className="w-6 h-6 text-gray-700 dark:text-text-secondary" />
        <h3 className="text-lg font-semibold text-gray-900 dark:text-text-primary">
          {t('通用设置', 'General Settings')}
        </h3>
      </div>

      <div className="p-6 bg-white dark:bg-panel-dark rounded-xl border border-black/[0.06] dark:border-white/[0.04]">
        <div className="flex items-center space-x-3 mb-4">
          <Globe className="w-5 h-5 text-gray-700 dark:text-text-secondary" />
          <h4 className="font-medium text-gray-900 dark:text-text-primary">
            {t('语言设置', 'Language Settings')}
          </h4>
        </div>
        
        <div className="grid grid-cols-2 gap-4 max-w-md">
          <label className="flex items-center space-x-3 cursor-pointer p-3 rounded-lg border border-black/[0.06] dark:border-white/[0.04] hover:bg-light-bg dark:hover:bg-white/10 transition-colors">
            <input
              type="radio"
              name="language"
              value="zh"
              checked={language === 'zh'}
              onChange={(e) => setLanguage(e.target.value as 'zh' | 'en')}
              className="w-4 h-4 text-brand-violet bg-light-surface border-black/[0.06] focus:ring-brand-violet dark:focus:ring-blue-600 dark:ring-offset-gray-800 focus:ring-2 dark:bg-white/[0.04] dark:border-white/[0.04]"
            />
            <div>
              <span className="text-base font-medium text-gray-900 dark:text-text-primary">
                中文
              </span>
              <p className="text-xs text-gray-500 dark:text-text-tertiary">
                Simplified Chinese
              </p>
            </div>
          </label>
          <label className="flex items-center space-x-3 cursor-pointer p-3 rounded-lg border border-black/[0.06] dark:border-white/[0.04] hover:bg-light-bg dark:hover:bg-white/10 transition-colors">
            <input
              type="radio"
              name="language"
              value="en"
              checked={language === 'en'}
              onChange={(e) => setLanguage(e.target.value as 'zh' | 'en')}
              className="w-4 h-4 text-brand-violet bg-light-surface border-black/[0.06] focus:ring-brand-violet dark:focus:ring-blue-600 dark:ring-offset-gray-800 focus:ring-2 dark:bg-white/[0.04] dark:border-white/[0.04]"
            />
            <div>
              <span className="text-base font-medium text-gray-900 dark:text-text-primary">
                English
              </span>
              <p className="text-xs text-gray-500 dark:text-text-tertiary">
                US English
              </p>
            </div>
          </label>
        </div>
      </div>

      <div className="p-6 bg-white dark:bg-panel-dark rounded-xl border border-black/[0.06] dark:border-white/[0.04]">
        <div className="flex items-center space-x-3 mb-4">
          <Package className="w-5 h-5 text-gray-700 dark:text-text-secondary " />
          <h4 className="font-medium text-gray-900 dark:text-text-primary">
            {t('检查更新', 'Check for Updates')}
          </h4>
        </div>
        
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-gray-700 dark:text-text-tertiary mb-1">
              {t(`当前版本: v${version}`, `Current Version: v${version}`)}
            </p>
            <p className="text-xs text-gray-500 dark:text-text-tertiary">
              {t('检查是否有新版本可用', 'Check if a new version is available')}
            </p>
          </div>
          <UpdateChecker />
        </div>
      </div>

      {/* Auto-sync section */}
      <div className="p-6 bg-white dark:bg-panel-dark rounded-xl border border-black/[0.06] dark:border-white/[0.04]">
        <div className="flex items-center space-x-3 mb-4">
          <Clock className="w-5 h-5 text-gray-700 dark:text-text-secondary" />
          <h4 className="font-medium text-gray-900 dark:text-text-primary">
            {t('自动同步', 'Auto Sync')}
          </h4>
        </div>

        {syncLoading ? (
          <div className="space-y-3">
            <div className="animate-pulse h-4 w-48 bg-gray-300 dark:bg-gray-600 rounded" />
            <div className="animate-pulse h-4 w-64 bg-gray-300 dark:bg-gray-600 rounded" />
            <div className="animate-pulse h-8 w-full bg-gray-300 dark:bg-gray-600 rounded" />
          </div>
        ) : (
          <div className="space-y-4">
            {!githubTokenConfigured && (
              <div className="flex items-start gap-2 p-3 bg-yellow-50 dark:bg-yellow-900/20 rounded-lg text-sm text-yellow-800 dark:text-yellow-200">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{t(
                  '请先在设置中配置 GitHub Token 以启用自动同步。',
                  'Please configure a GitHub Token in settings first to enable auto sync.'
                )}</span>
              </div>
            )}

            {/* Sync type checkboxes */}
            <div className="space-y-2">
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
                {t('同步内容', 'Sync Content')}
              </p>
              <label className="flex items-center space-x-3 cursor-pointer p-2 rounded-lg hover:bg-light-bg dark:hover:bg-white/5 transition-colors">
                <input
                  type="checkbox"
                  checked={enabledRepos}
                  onChange={(e) => setEnabledRepos(e.target.checked)}
                  className="w-4 h-4 text-brand-violet bg-light-surface border-black/[0.06] focus:ring-brand-violet dark:focus:ring-blue-600 dark:ring-offset-gray-800 focus:ring-2 dark:bg-white/[0.04] dark:border-white/[0.04] rounded"
                />
                <span className="text-sm text-gray-900 dark:text-text-primary">
                  {t('星标仓库列表', 'Starred Repositories')}
                </span>
              </label>
              <label className="flex items-center space-x-3 cursor-pointer p-2 rounded-lg hover:bg-light-bg dark:hover:bg-white/5 transition-colors">
                <input
                  type="checkbox"
                  checked={enabledForks}
                  onChange={(e) => setEnabledForks(e.target.checked)}
                  className="w-4 h-4 text-brand-violet bg-light-surface border-black/[0.06] focus:ring-brand-violet dark:focus:ring-blue-600 dark:ring-offset-gray-800 focus:ring-2 dark:bg-white/[0.04] dark:border-white/[0.04] rounded"
                />
                <span className="text-sm text-gray-900 dark:text-text-primary">
                  {t('复刻', 'Forks')}
                </span>
              </label>
              <label className="flex items-center space-x-3 cursor-pointer p-2 rounded-lg hover:bg-light-bg dark:hover:bg-white/5 transition-colors">
                <input
                  type="checkbox"
                  checked={enabledReleases}
                  onChange={(e) => setEnabledReleases(e.target.checked)}
                  className="w-4 h-4 text-brand-violet bg-light-surface border-black/[0.06] focus:ring-brand-violet dark:focus:ring-blue-600 dark:ring-offset-gray-800 focus:ring-2 dark:bg-white/[0.04] dark:border-white/[0.04] rounded"
                />
                <span className="text-sm text-gray-900 dark:text-text-primary">
                  Release
                </span>
              </label>
            </div>

            {/* Interval */}
            <div>
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                {t('同步间隔', 'Sync Interval')}
              </p>
              <div className="flex items-center gap-2">
                <div className="flex-1">
                  <input
                    type="number"
                    min={0}
                    max={720}
                    value={intervalHours}
                    onChange={(e) => setIntervalHours(Math.max(0, Math.min(720, parseInt(e.target.value) || 0)))}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                  />
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    {t('小时', 'Hours')}
                  </p>
                </div>
                <div className="flex-1">
                  <input
                    type="number"
                    min={0}
                    max={59}
                    value={intervalMinutes}
                    onChange={(e) => setIntervalMinutes(Math.max(0, Math.min(59, parseInt(e.target.value) || 0)))}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                  />
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    {t('分钟', 'Minutes')}
                  </p>
                </div>
              </div>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {t('默认24小时，范围: 1分钟 - 30天', 'Default 24h, range: 1 min - 30 days')}
              </p>
            </div>

            {/* Save button */}
            <button
              onClick={handleSyncSave}
              disabled={syncSaving}
              className="w-full px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg transition-colors flex items-center justify-center gap-2"
            >
              <RotateCw className={`w-4 h-4 ${syncSaving ? 'animate-spin' : ''}`} />
              {syncSaving ? t('保存中...', 'Saving...') : t('保存设置', 'Save Settings')}
            </button>

            {/* Status */}
            <div className="p-3 bg-gray-50 dark:bg-gray-800 rounded-lg space-y-2 text-sm">
              <div className="flex items-center gap-2">
                {syncEnabled ? (
                  <CheckCircle2 className="w-4 h-4 text-green-500" />
                ) : (
                  <AlertCircle className="w-4 h-4 text-gray-400" />
                )}
                <span className="text-gray-600 dark:text-gray-400">
                  {t('状态', 'Status')}: {syncEnabled ? t('已启用', 'Enabled') : t('已禁用', 'Disabled')}
                </span>
              </div>
              {syncIsSyncing && (
                <div className="flex items-center gap-2 text-blue-600 dark:text-blue-400">
                  <RotateCw className="w-3 h-3 animate-spin" />
                  <span>{t('同步中...', 'Syncing...')}</span>
                </div>
              )}
              <div className="text-gray-600 dark:text-gray-400">
                {t('上次同步', 'Last Sync')}: {formatTime(lastSync)}
              </div>
              {syncEnabled && nextSync && (
                <div className="text-gray-600 dark:text-gray-400">
                  {t('下次同步', 'Next Sync')}: {formatTime(nextSync)}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="p-6 bg-white dark:bg-panel-dark rounded-xl border border-black/[0.06] dark:border-white/[0.04]">
        <div className="flex items-center space-x-3 mb-4">
          <Mail className="w-5 h-5 text-gray-700 dark:text-text-secondary" />
          <h4 className="font-medium text-gray-900 dark:text-text-primary">
            {t('联系方式', 'Contact Information')}
          </h4>
        </div>
        
        <p className="text-sm text-gray-700 dark:text-text-tertiary mb-4">
          {t('如果您在使用过程中遇到任何问题或有建议，欢迎通过以下方式联系我：', 'If you encounter any issues or have suggestions while using the app, feel free to contact me through:')}
        </p>
        
        <div className="flex flex-col sm:flex-row gap-3">
          <button
            onClick={() => {
              const newWindow = window.open('https://x.com/GoodMan_Lee', '_blank', 'noopener,noreferrer');
              if (newWindow) {
                newWindow.opener = null;
              }
            }}
            className="flex items-center justify-center space-x-2 px-4 py-3 bg-brand-indigo hover:bg-brand-hover text-white rounded-lg transition-colors"
          >
            <Twitter className="w-5 h-5" />
            <span>Twitter</span>
            <ExternalLink className="w-4 h-4" />
          </button>
          
          <button
            onClick={() => {
              const newWindow = window.open(PROJECT_REPO_URL, '_blank', 'noopener,noreferrer');
              if (newWindow) {
                newWindow.opener = null;
              }
            }}
            className="flex items-center justify-center space-x-2 px-4 py-3 bg-light-surface hover:bg-gray-200 dark:bg-white/[0.04] dark:hover:bg-white/[0.08] text-gray-900 dark:text-text-primary border border-black/[0.06] dark:border-white/[0.04] rounded-lg transition-colors"
          >
            <Github className="w-5 h-5" />
            <span>{t('GitHub', 'GitHub')}</span>
            <ExternalLink className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};
