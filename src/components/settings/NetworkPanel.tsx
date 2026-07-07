import React, { useState, useEffect } from 'react';
import { Wifi, Eye, EyeOff, Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { backend } from '../../services/backendAdapter';
import type { ProxyConfig } from '../../types';

interface NetworkPanelProps {
  t: (zh: string, en: string) => string;
}

export const NetworkPanel: React.FC<NetworkPanelProps> = ({ t }) => {
  const { proxyConfig, setProxyConfig, backendApiSecret } = useAppStore();

  const [form, setForm] = useState<ProxyConfig>(proxyConfig);
  const [showPassword, setShowPassword] = useState(false);
  const [showAuth, setShowAuth] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setForm(proxyConfig);
    if (proxyConfig.username || proxyConfig.password) {
      setShowAuth(true);
    }
  }, [proxyConfig]);

  const canUseProxy = backend.isAvailable;

  const isFormValid = !form.enabled || (form.host.trim() && form.port >= 1 && form.port <= 65535);

  const handleSave = async () => {
    if (!isFormValid) return;

    setSaving(true);
    setTestResult(null);
    try {
      const configToSave: ProxyConfig = {
        ...form,
        username: showAuth ? form.username : undefined,
        password: showAuth ? form.password : undefined,
      };
      setProxyConfig(configToSave);

      if (backend.isAvailable) {
        await backend.syncSettings({ proxyConfig: configToSave });
      }
    } catch (err) {
      console.error('Failed to save proxy config:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      if (!backend.isAvailable) {
        setTestResult({ success: false, error: t('后端不可用', 'Backend not available') });
        return;
      }

      const base = backend.backendUrl;
      const authHeaders: Record<string, string> = {};
      if (backendApiSecret) {
        authHeaders['Authorization'] = `Bearer ${backendApiSecret}`;
      }

      const resp = await fetch(`${base}/settings/proxy/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify(form),
      });

      if (resp.ok) {
        setTestResult({ success: true });
      } else {
        const data = await resp.json().catch(() => ({}));
        setTestResult({ success: false, error: data.error || `HTTP ${resp.status}` });
      }
    } catch (err) {
      setTestResult({ success: false, error: err instanceof Error ? err.message : 'Unknown error' });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center space-x-3 mb-6">
        <Wifi className="w-6 h-6 text-brand-indigo" />
        <h2 className="text-lg font-semibold text-gray-900 dark:text-text-primary">
          {t('网络代理', 'Network Proxy')}
        </h2>
      </div>

      {!canUseProxy && (
        <div className="p-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
          <p className="text-sm text-yellow-800 dark:text-yellow-200">
            {t('网络代理需要后端服务支持', 'Network proxy requires backend service')}
          </p>
        </div>
      )}

      <div className="space-y-4">
        <label className="flex items-center space-x-3 cursor-pointer">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm(prev => ({ ...prev, enabled: e.target.checked }))}
            className="w-4 h-4 text-brand-indigo border-gray-300 rounded focus:ring-brand-indigo"
          />
          <span className="text-sm font-medium text-gray-900 dark:text-text-primary">
            {t('启用代理', 'Enable Proxy')}
          </span>
        </label>

        {form.enabled && (
          <div className="space-y-4 pl-7">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-text-secondary mb-1">
                  {t('代理类型', 'Proxy Type')}
                </label>
                <select
                  value={form.type}
                  onChange={(e) => setForm(prev => ({ ...prev, type: e.target.value as 'http' | 'socks5' }))}
                  className="w-full px-3 py-2 border border-black/[0.06] dark:border-white/[0.04] rounded-lg bg-white dark:bg-panel-dark text-gray-900 dark:text-text-primary focus:ring-2 focus:ring-brand-indigo focus:border-transparent"
                >
                  <option value="http">HTTP</option>
                  <option value="socks5">SOCKS5</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-text-secondary mb-1">
                  {t('主机地址', 'Host')} *
                </label>
                <input
                  type="text"
                  value={form.host}
                  onChange={(e) => setForm(prev => ({ ...prev, host: e.target.value }))}
                  placeholder="127.0.0.1"
                  className="w-full px-3 py-2 border border-black/[0.06] dark:border-white/[0.04] rounded-lg bg-white dark:bg-panel-dark text-gray-900 dark:text-text-primary focus:ring-2 focus:ring-brand-indigo focus:border-transparent"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-text-secondary mb-1">
                  {t('端口', 'Port')} *
                </label>
                <input
                  type="number"
                  value={form.port}
                  onChange={(e) => setForm(prev => ({ ...prev, port: parseInt(e.target.value) || 0 }))}
                  min={1}
                  max={65535}
                  placeholder="8080"
                  className="w-full px-3 py-2 border border-black/[0.06] dark:border-white/[0.04] rounded-lg bg-white dark:bg-panel-dark text-gray-900 dark:text-text-primary focus:ring-2 focus:ring-brand-indigo focus:border-transparent"
                />
              </div>
            </div>

            <label className="flex items-center space-x-3 cursor-pointer">
              <input
                type="checkbox"
                checked={showAuth}
                onChange={(e) => {
                  setShowAuth(e.target.checked);
                  if (!e.target.checked) {
                    setForm(prev => ({ ...prev, username: '', password: '' }));
                  }
                }}
                className="w-4 h-4 text-brand-indigo border-gray-300 rounded focus:ring-brand-indigo"
              />
              <span className="text-sm font-medium text-gray-700 dark:text-text-secondary">
                {t('需要认证', 'Require Authentication')}
              </span>
            </label>

            {showAuth && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pl-7">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-text-secondary mb-1">
                    {t('用户名', 'Username')}
                  </label>
                  <input
                    type="text"
                    value={form.username || ''}
                    onChange={(e) => setForm(prev => ({ ...prev, username: e.target.value }))}
                    className="w-full px-3 py-2 border border-black/[0.06] dark:border-white/[0.04] rounded-lg bg-white dark:bg-panel-dark text-gray-900 dark:text-text-primary focus:ring-2 focus:ring-brand-indigo focus:border-transparent"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-text-secondary mb-1">
                    {t('密码', 'Password')}
                  </label>
                  <div className="relative">
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={form.password || ''}
                      onChange={(e) => setForm(prev => ({ ...prev, password: e.target.value }))}
                      className="w-full px-3 py-2 pr-10 border border-black/[0.06] dark:border-white/[0.04] rounded-lg bg-white dark:bg-panel-dark text-gray-900 dark:text-text-primary focus:ring-2 focus:ring-brand-indigo focus:border-transparent"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-500 hover:text-gray-700 dark:text-text-tertiary dark:hover:text-text-secondary"
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {testResult && (
        <div className={`flex items-center space-x-2 p-3 rounded-lg ${testResult.success ? 'bg-green-50 dark:bg-green-900/20' : 'bg-red-50 dark:bg-red-900/20'}`}>
          {testResult.success ? (
            <CheckCircle2 className="w-5 h-5 text-green-600 dark:text-green-400" />
          ) : (
            <XCircle className="w-5 h-5 text-red-600 dark:text-red-400" />
          )}
          <span className={`text-sm ${testResult.success ? 'text-green-700 dark:text-green-300' : 'text-red-700 dark:text-red-300'}`}>
            {testResult.success
              ? t('连接成功', 'Connection successful')
              : testResult.error || t('连接失败', 'Connection failed')}
          </span>
        </div>
      )}

      <div className="flex items-center space-x-3 pt-4 border-t border-black/[0.06] dark:border-white/[0.04]">
        <button
          onClick={handleSave}
          disabled={!isFormValid || saving}
          className="px-4 py-2 bg-brand-indigo text-white rounded-lg hover:bg-brand-indigo/90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center space-x-2"
        >
          {saving && <Loader2 className="w-4 h-4 animate-spin" />}
          <span>{t('保存', 'Save')}</span>
        </button>

        {form.enabled && (
          <button
            onClick={handleTest}
            disabled={testing || !isFormValid}
            className="px-4 py-2 border border-brand-indigo text-brand-indigo rounded-lg hover:bg-brand-indigo/10 disabled:opacity-50 disabled:cursor-not-allowed flex items-center space-x-2"
          >
            {testing && <Loader2 className="w-4 h-4 animate-spin" />}
            <span>{t('测试连接', 'Test Connection')}</span>
          </button>
        )}
      </div>
    </div>
  );
};
