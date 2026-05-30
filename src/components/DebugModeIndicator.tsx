import React, { useCallback, useEffect, useState } from 'react';
import { backend } from '../services/backendAdapter';
import { logger } from '../services/logger';
import { useAppStore } from '../store/useAppStore';

export const DebugModeIndicator: React.FC = () => {
  const [frontendDebug, setFrontendDebug] = useState(() => sessionStorage.getItem('gsm:frontend-debug') === 'true');
  const [backendDebug, setBackendDebug] = useState(() => sessionStorage.getItem('gsm:backend-debug') === 'true');
  const backendApiSecret = useAppStore((state) => state.backendApiSecret);
  const setCurrentView = useAppStore((state) => state.setCurrentView);

  useEffect(() => {
    const syncState = () => {
      setFrontendDebug(sessionStorage.getItem('gsm:frontend-debug') === 'true');
      setBackendDebug(sessionStorage.getItem('gsm:backend-debug') === 'true');
    };
    const interval = window.setInterval(syncState, 2000);
    window.addEventListener('storage', syncState);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('storage', syncState);
    };
  }, []);

  const handleClick = useCallback(async () => {
    logger.setLevel('info');
    sessionStorage.setItem('gsm:frontend-debug', 'false');
    setFrontendDebug(false);

    if (backend.isAvailable) {
      try {
        await fetch(`${backend.backendUrl}/logs/debug`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(backendApiSecret ? { Authorization: `Bearer ${backendApiSecret}` } : {}),
          },
          body: JSON.stringify({ enabled: false }),
        });
      } catch (err) {
        logger.errorFromError('debugIndicator', 'Failed to disable backend debug mode', err);
      }
    }

    sessionStorage.setItem('gsm:backend-debug', 'false');
    setBackendDebug(false);
    sessionStorage.setItem('gsm:pending-settings-tab', 'logs');
    setCurrentView('settings');
    window.dispatchEvent(new CustomEvent('gsm:navigate-to-settings-tab', { detail: { tab: 'logs' } }));
  }, [backendApiSecret, setCurrentView]);

  if (!frontendDebug && !backendDebug) return null;

  return (
    <button
      onClick={handleClick}
      className="fixed bottom-6 right-6 z-50 flex items-center gap-2 px-3 py-2 bg-green-500 text-white rounded-full shadow-lg hover:bg-green-600 transition-colors text-sm font-medium"
      title="DEBUG"
    >
      <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
      <span>DEBUG</span>
      {frontendDebug && <span className="text-xs opacity-80">FE</span>}
      {backendDebug && <span className="text-xs opacity-80">BE</span>}
    </button>
  );
};
