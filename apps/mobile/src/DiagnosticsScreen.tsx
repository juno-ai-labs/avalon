import { useState } from 'react';
import { Alert, Linking, Pressable, ScrollView, Text, View } from 'react-native';
import * as Updates from 'expo-updates';
import * as Network from 'expo-network';
import * as BackgroundTask from 'expo-background-task';
import { useRuntimeStatus, diagnosticSummary, shareDiagnostics } from './diagnostics';
import { downloadUpdate } from './background';
import { useTheme } from './theme';

type NotificationsControl = { permission: string; registration: string; enable: () => Promise<void>; retry: () => Promise<void> };
export function DiagnosticsScreen({ notifications, signedIn }: { notifications: NotificationsControl; signedIn: boolean }) {
  const { colors } = useTheme();
  const status = useRuntimeStatus();
  const network = Network.useNetworkState();
  const { isUpdatePending } = Updates.useUpdates();
  const [background, setBackground] = useState<string | null>(null);
  const button = (title: string, action: () => void, disabled = false) => <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={action} style={{ paddingVertical: 16, opacity: disabled ? 0.5 : 1 }}><Text style={{ color: colors.text, fontSize: 17 }}>{title}</Text></Pressable>;
  return <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ backgroundColor: colors.background }} contentContainerStyle={{ padding: 24, gap: 12 }}>
    <Text accessibilityRole="header" style={{ color: colors.text, fontSize: 22, fontWeight: '600' }}>Notifications</Text>
    <Text style={{ color: colors.muted }}>{notifications.permission} · {notifications.registration}</Text>
    {button(signedIn ? 'Enable notifications' : 'Sign in to enable notifications', () => { void notifications.enable(); }, !signedIn)}
    {button('Notification settings', () => { void Linking.openSettings().catch(() => Alert.alert('Settings unavailable', 'Open Rally’s settings in the Settings app.')); })}
    <Text accessibilityRole="header" style={{ color: colors.text, fontSize: 22, fontWeight: '600' }}>Updates</Text>
    <Text style={{ color: colors.muted }}>{isUpdatePending || status.update === 'ready' ? 'An update is downloaded. It will apply the next time Rally starts.' : status.update === 'development' ? 'Updates are available in installed release builds.' : status.update === 'failed' ? 'The update check failed. Try again when you’re connected.' : status.update === 'checking' ? 'Checking for an update…' : 'Updates download automatically.'}</Text>
    {button('Check for updates', () => { void downloadUpdate().catch(() => undefined); }, __DEV__ || !Updates.isEnabled || status.update === 'checking')}
    {(isUpdatePending || status.update === 'ready') && button('Restart to apply update', () => Alert.alert('Restart Rally?', 'Finish any unsent edits first.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Restart', onPress: () => { void Updates.reloadAsync().catch(() => Alert.alert('Restart failed', 'Close and reopen Rally to apply the update.')); } }]))}
    <Text accessibilityRole="header" style={{ color: colors.text, fontSize: 22, fontWeight: '600' }}>Diagnostics</Text>
    <Text style={{ color: colors.muted }}>Connection: {network.isConnected === false ? 'offline' : network.isConnected ? network.type : 'checking'}</Text>
    {button('Check background refresh', () => { void BackgroundTask.getStatusAsync().then((value) => setBackground(value === BackgroundTask.BackgroundTaskStatus.Available ? 'Available; the operating system chooses when it runs.' : 'Unavailable. Check system settings; iOS Simulator cannot run background tasks.'), () => setBackground('Background refresh status is unavailable.')); })}
    {background && <Text style={{ color: colors.muted }}>{background}</Text>}
    <Text style={{ color: colors.muted }}>Sharing diagnostics includes app versions and technical status only. It excludes conversations, canvas names, and sign-in information.</Text>
    {button('Share diagnostics', () => { void shareDiagnostics().catch(() => undefined); })}
    <View style={{ padding: 16, backgroundColor: colors.surface, borderRadius: 12 }}><Text selectable style={{ color: colors.muted, fontSize: 12 }}>{diagnosticSummary()}</Text></View>
  </ScrollView>;
}
