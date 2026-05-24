import { useEffect } from 'react';
import { UpdateService } from '../services/updateService';
import { useAppStore } from '../store/useAppStore';

export const useAutoUpdateCheck = () => {
  const { setUpdateNotification } = useAppStore();

  useEffect(() => {
    const checkUpdatesOnStartup = async () => {
      try {
        const result = await UpdateService.checkForUpdates();
        if (result.hasUpdate && result.latestVersion) {
          console.log('New version available:', result.latestVersion.number);

          setUpdateNotification({
            version: result.latestVersion.number,
            releaseDate: result.latestVersion.releaseDate,
            changelog: result.latestVersion.changelog,
            downloadUrl: result.latestVersion.downloadUrl,
            dismissed: false
          });
        }
      } catch (error) {
        console.error('Startup update check failed:', error);
      }
    };

    const timer = setTimeout(checkUpdatesOnStartup, 3000);
    return () => clearTimeout(timer);
  }, [setUpdateNotification]);
};
