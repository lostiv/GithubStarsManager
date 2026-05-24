import React, { useState } from 'react';
import ReactDOM from 'react-dom';
import { Calendar, Download, ExternalLink, Package, RefreshCw } from 'lucide-react';
import { useDialog } from '../hooks/useDialog';
import { UpdateService, VersionInfo } from '../services/updateService';
import { useAppStore } from '../store/useAppStore';

interface UpdateCheckerProps {
  onUpdateAvailable?: (version: VersionInfo) => void;
}

export const UpdateChecker: React.FC<UpdateCheckerProps> = ({ onUpdateAvailable }) => {
  const { language, setUpdateNotification } = useAppStore();
  const { toast } = useDialog();
  const [isChecking, setIsChecking] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<VersionInfo | null>(null);
  const [showUpdateDialog, setShowUpdateDialog] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const t = (zh: string, en: string) => language === 'zh' ? zh : en;

  const checkForUpdates = async (silent = false) => {
    setIsChecking(true);
    setError(null);

    try {
      const result = await UpdateService.checkForUpdates();

      if (result.hasUpdate && result.latestVersion) {
        setUpdateInfo(result.latestVersion);
        setShowUpdateDialog(true);
        onUpdateAvailable?.(result.latestVersion);

        setUpdateNotification({
          version: result.latestVersion.number,
          releaseDate: result.latestVersion.releaseDate,
          changelog: result.latestVersion.changelog,
          downloadUrl: result.latestVersion.downloadUrl,
          dismissed: false
        });
      } else if (!silent) {
        toast(t('褰撳墠宸叉槸鏈€鏂扮増鏈紒', 'You are already using the latest version!'), 'info');
      }
    } catch (checkError) {
      const errorMessage = t(
        '妫€鏌ユ洿鏂板け璐ワ紝璇锋鏌ョ綉缁滆繛鎺?',
        'Failed to check for updates. Please check your network connection.'
      );
      setError(errorMessage);
      if (!silent) {
        toast(errorMessage, 'error');
      }
      console.error('Update check failed:', checkError);
    } finally {
      setIsChecking(false);
    }
  };

  const handleDownload = () => {
    if (updateInfo?.downloadUrl) {
      UpdateService.openDownloadUrl(updateInfo.downloadUrl);
      setShowUpdateDialog(false);
    }
  };

  const formatDate = (dateString: string) => {
    try {
      return new Date(dateString).toLocaleDateString(language === 'zh' ? 'zh-CN' : 'en-US');
    } catch {
      return dateString;
    }
  };

  return (
    <>
      <button
        onClick={() => checkForUpdates(false)}
        disabled={isChecking}
        className="flex items-center space-x-2 px-4 py-2 bg-brand-indigo text-white rounded-lg hover:bg-brand-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isChecking ? (
          <RefreshCw className="w-4 h-4 animate-spin" />
        ) : (
          <Download className="w-4 h-4" />
        )}
        <span>
          {isChecking
            ? t('妫€鏌ヤ腑...', 'Checking...')
            : t('妫€鏌ユ洿鏂?', 'Check for Updates')}
        </span>
      </button>

      {error && (
        <div className="mt-2 rounded-lg border border-black/[0.06] bg-gray-100 p-3 dark:border-white/[0.04] dark:bg-white/[0.04]">
          <p className="text-sm text-gray-700 dark:text-text-secondary">{error}</p>
        </div>
      )}

      {showUpdateDialog && updateInfo && ReactDOM.createPortal(
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setShowUpdateDialog(false);
            }
          }}
        >
          <div className="max-h-[80vh] w-full max-w-md overflow-y-auto rounded-xl bg-white shadow-xl dark:bg-panel-dark">
            <div className="p-6">
              <div className="mb-4 flex items-center space-x-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-indigo/20 dark:bg-brand-indigo/20">
                  <Package className="h-6 w-6 text-brand-violet dark:text-brand-violet" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-text-primary">
                    {t('鍙戠幇鏂扮増鏈?', 'New Version Available')}
                  </h3>
                  <p className="text-sm text-gray-500 dark:text-text-tertiary">v{updateInfo.number}</p>
                </div>
              </div>

              <div className="mb-4">
                <div className="mb-3 flex items-center space-x-2 text-sm text-gray-700 dark:text-text-tertiary">
                  <Calendar className="h-4 w-4" />
                  <span>{t('鍙戝竷鏃ユ湡:', 'Release Date:')} {formatDate(updateInfo.releaseDate)}</span>
                </div>

                <div className="mb-4">
                  <h4 className="mb-2 font-medium text-gray-900 dark:text-text-primary">
                    {t('鏇存柊鍐呭:', "What's New:")}
                  </h4>
                  <ul className="space-y-1">
                    {updateInfo.changelog.map((item, index) => (
                      <li
                        key={index}
                        className="flex items-start space-x-2 text-sm text-gray-700 dark:text-text-tertiary"
                      >
                        <span className="mt-2 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-brand-violet" />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              <div className="flex space-x-3">
                <button
                  onClick={handleDownload}
                  className="flex flex-1 items-center justify-center space-x-2 rounded-lg bg-brand-indigo px-4 py-2 text-white transition-colors hover:bg-brand-hover"
                >
                  <ExternalLink className="h-4 w-4" />
                  <span>{t('绔嬪嵆涓嬭浇', 'Download Now')}</span>
                </button>
                <button
                  onClick={() => setShowUpdateDialog(false)}
                  className="rounded-lg bg-gray-200 px-4 py-2 text-gray-900 transition-colors hover:bg-gray-300 dark:bg-white/[0.04] dark:text-text-secondary dark:hover:bg-gray-600"
                >
                  {t('绋嶅悗鎻愰啋', 'Later')}
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
};
