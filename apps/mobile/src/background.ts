import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import * as Updates from 'expo-updates';
import { isDevice } from 'expo-device';
import { Platform } from 'react-native';
import { recordFailure, setRuntimeStatus } from './diagnostics';

const TASK = 'rally-background-update';
let checking: Promise<void> | null = null;

/** Download only: applying an update must never interrupt a conversation or form. */
export function downloadUpdate(): Promise<void> {
  if (__DEV__ || !Updates.isEnabled) return Promise.resolve();
  if (checking) return checking;
  checking = (async () => {
    setRuntimeStatus({ update: 'checking' });
    try {
      const result = await Updates.checkForUpdateAsync();
      if (result.isAvailable || result.isRollBackToEmbedded) {
        await Updates.fetchUpdateAsync();
        setRuntimeStatus({ update: 'ready' });
      } else setRuntimeStatus({ update: 'current' });
    } catch (error) {
      setRuntimeStatus({ update: 'failed' });
      recordFailure('update_check_failed');
      throw error;
    } finally { checking = null; }
  })();
  return checking;
}

TaskManager.defineTask(TASK, async () => {
  try {
    await downloadUpdate();
    setRuntimeStatus({ lastBackgroundSync: new Date().toISOString() });
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch { return BackgroundTask.BackgroundTaskResult.Failed; }
});

export async function registerBackgroundSync(): Promise<void> {
  if (__DEV__ || !Updates.isEnabled) return;
  // BGTaskScheduler is unavailable on iOS Simulator. Use the platform's default cadence.
  if (Platform.OS === 'ios' && !isDevice) return;
  try {
    if (await BackgroundTask.getStatusAsync() !== BackgroundTask.BackgroundTaskStatus.Available) return;
    if (!await TaskManager.isTaskRegisteredAsync(TASK)) await BackgroundTask.registerTaskAsync(TASK);
  } catch { recordFailure('background_registration_failed'); }
}
