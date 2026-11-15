import { notificationPayload } from './notification-target';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import * as Application from 'expo-application';
import { randomUUID } from 'expo-crypto';
import { APNS_TOPICS, type RegisterPushDeviceRequest } from '@rally/contracts/push-notifications';
import { recordFailure } from './diagnostics';
import type { MobileCommand, MobileEvent, MobileSnapshot } from './protocol';

Notifications.setNotificationHandler({ handleNotification: async () => ({
  shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false,
}) });
let installation: Promise<string> | null = null;
function installationId(): Promise<string> {
  if (!installation) installation = (async () => {
    const previous = await SecureStore.getItemAsync('rally-push-installation');
    if (previous) return previous;
    const id = randomUUID();
    await SecureStore.setItemAsync('rally-push-installation', id);
    return id;
  })().catch((error: unknown) => { installation = null; throw error; });
  return installation;
}
function allowed(permission: Notifications.NotificationPermissionsStatus): boolean {
  return permission.granted || permission.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
}
export function useNotifications(directory: MobileSnapshot | null, send: (command: MobileCommand) => void, onOpen: (data: unknown) => void) {
  const [permission, setPermission] = useState('not requested');
  const [registration, setRegistration] = useState('not registered');
  const latest = useRef(directory); latest.current = directory;
  const generation = useRef(0);
  const requestId = useRef<string | null>(null);
  const synchronize = useCallback(async (requestPermission = false, changedToken?: Notifications.DevicePushToken) => {
    const current = ++generation.current;
    if (Platform.OS !== 'ios') { setPermission('unavailable'); setRegistration('unavailable'); return; }
    const owner = latest.current;
    if (!owner) { setRegistration('not registered'); return; }
    try {
      const permissions = requestPermission ? await Notifications.requestPermissionsAsync() : await Notifications.getPermissionsAsync();
      if (current !== generation.current || latest.current?.userId !== owner.userId || latest.current.workspaceId !== owner.workspaceId) return;
      const permitted = allowed(permissions);
      setPermission(permitted ? 'allowed' : permissions.canAskAgain ? 'not requested' : 'off in system settings');
      const id = await installationId();
      let input: RegisterPushDeviceRequest | null = null;
      if (permitted) {
        const native = changedToken ?? await Notifications.getDevicePushTokenAsync();
        const token = String(native.data);
        const appVersion = Application.nativeApplicationVersion ?? 'unknown';
        input = { platform: 'ios', transport: 'apns', topic: APNS_TOPICS.ios, apnsEnvironment: 'production', token, appVersion };
      }
      if (current !== generation.current || latest.current?.userId !== owner.userId || latest.current.workspaceId !== owner.workspaceId) return;
      requestId.current = randomUUID();
      setRegistration(permitted ? 'registering' : 'off');
      send({ type: 'push-device', requestId: requestId.current, userId: owner.userId, workspaceId: owner.workspaceId, installationId: id, registration: input });
    } catch {
      if (current === generation.current) { setRegistration('registration failed'); recordFailure('notification_registration_failed'); }
    }
  }, [send]);
  useEffect(() => {
    void synchronize();
    const foreground = AppState.addEventListener('change', (state) => { if (state === 'active') void synchronize(); });
    const token = Notifications.addPushTokenListener((token) => { void synchronize(false, token); });
    return () => { generation.current++; requestId.current = null; foreground.remove(); token.remove(); };
  }, [directory?.userId, directory?.workspaceId, synchronize]);
  useEffect(() => {
    let active = true;
    const open = (response: Notifications.NotificationResponse) => {
      if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
      const { trigger, content } = response.notification.request;
      onOpen(notificationPayload(trigger, content.data));
    };
    const listener = Notifications.addNotificationResponseReceivedListener(open);
    void Notifications.getLastNotificationResponseAsync().then((response) => { if (active && response) open(response); }).catch(() => undefined);
    return () => { active = false; listener.remove(); };
  }, [onOpen]);
  const receive = useCallback((event: MobileEvent) => {
    if (event.type !== 'push-device-result' || event.requestId !== requestId.current || event.userId !== latest.current?.userId || event.workspaceId !== latest.current?.workspaceId) return;
    setRegistration(event.ok ? event.enabled ? 'registered' : 'off' : 'registration failed');
    if (!event.ok) recordFailure('notification_registration_failed');
  }, []);
  return useMemo(() => ({ permission, registration, enable: () => synchronize(true), retry: () => synchronize(), receive }), [permission, registration, synchronize, receive]);
}
