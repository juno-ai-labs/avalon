import { Alert, Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Application from 'expo-application';
import * as Updates from 'expo-updates';
import { ArrowLeftRight, Bell, BellRing, Brain, CreditCard, Download, LogOut, MonitorCog, Plug, ShieldCheck, Stethoscope, UserRound, Users, UsersRound, type LucideIcon } from 'lucide-react-native';
import { SettingsGroup, SettingsRow } from './SettingsList';
import { useRuntimeStatus } from './diagnostics';
import { downloadUpdate } from './background';
import { useTheme } from './theme';
import type { MobileSettingsSection, MobileSnapshot } from './protocol';

export type NotificationsControl = { permission: string; registration: string; enable: () => Promise<void>; retry: () => Promise<void> };

/** The shared Settings pages, in the desktop's order and with its names and icons. */
const ACCOUNT_PAGES: ReadonlyArray<{ section: MobileSettingsSection; label: string; icon: LucideIcon; detail?: string }> = [
  { section: 'preferences', label: 'Preferences', icon: MonitorCog },
  { section: 'notifications', label: 'Notifications', icon: Bell, detail: 'What Rally tells you about' },
  { section: 'memories', label: 'Memories', icon: Brain },
];
const ORGANIZATION_PAGES: ReadonlyArray<{ section: MobileSettingsSection; label: string; icon: LucideIcon }> = [
  { section: 'workspace', label: 'Organization', icon: Users },
  { section: 'members', label: 'Members', icon: UsersRound },
  { section: 'billing', label: 'Billing', icon: CreditCard },
  { section: 'internet-access', label: 'Security', icon: ShieldCheck },
  { section: 'connections', label: 'Connections', icon: Plug },
];

export function SettingsScreen({ directory, notifications, openSection, switchOrganization, signOut, openDiagnostics }: {
  /** Home's last snapshot; null while signed out. */
  directory: Pick<MobileSnapshot, 'userName' | 'workspaceName' | 'settingsSections'> | null;
  notifications: NotificationsControl;
  openSection: (section: MobileSettingsSection) => void;
  switchOrganization: () => void;
  signOut: () => void;
  openDiagnostics: () => void;
}) {
  const { colors } = useTheme();
  const status = useRuntimeStatus();
  const { isUpdatePending } = Updates.useUpdates();
  const available = new Set(directory?.settingsSections ?? []);
  const page = ({ section, label, icon, detail }: { section: MobileSettingsSection; label: string; icon: LucideIcon; detail?: string }) =>
    available.has(section) ? <SettingsRow key={section} label={label} icon={icon} detail={detail} navigates onPress={() => openSection(section)} /> : null;
  const updateReady = isUpdatePending || status.update === 'ready';
  const updatesOff = __DEV__ || !Updates.isEnabled;
  const version = [Application.nativeApplicationVersion, Application.nativeBuildVersion && `(${Application.nativeBuildVersion})`].filter(Boolean).join(' ');
  return <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ backgroundColor: colors.background }} contentContainerStyle={styles.content}>
    {directory && <SettingsGroup>
      <View style={styles.identity}>
        <View style={[styles.avatar, { backgroundColor: colors.background }]}><Text style={[styles.initial, { color: colors.text }]}>{directory.userName.slice(0, 1).toUpperCase()}</Text></View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={[styles.name, { color: colors.text }]}>{directory.userName}</Text>
          <Text numberOfLines={1} style={{ color: colors.muted, fontSize: 15, marginTop: 2 }}>{directory.workspaceName}</Text>
        </View>
      </View>
      {page({ section: 'account', label: 'Profile', icon: UserRound })}
      <SettingsRow label="Switch organization" icon={ArrowLeftRight} onPress={switchOrganization} />
    </SettingsGroup>}
    {directory && <SettingsGroup title="Account">{ACCOUNT_PAGES.map(page)}</SettingsGroup>}
    {directory && <SettingsGroup title={directory.workspaceName || 'Organization'}>{ORGANIZATION_PAGES.map(page)}</SettingsGroup>}
    <SettingsGroup title="This device" footer={notificationsFooter(notifications.permission, notifications.registration, Boolean(directory))}>
      <SettingsRow label="Push notifications" icon={BellRing} value={notificationsValue(notifications.permission, notifications.registration)}
        disabled={notifications.permission === 'unavailable' || (!directory && notifications.permission === 'not requested')}
        onPress={() => {
          if (notifications.permission === 'not requested') { void notifications.enable(); return; }
          if (notifications.registration === 'registration failed') { void notifications.retry(); return; }
          void Linking.openSettings().catch(() => Alert.alert('Settings unavailable', 'Open Rally’s settings in the Settings app.'));
        }} />
      <SettingsRow label={updateReady ? 'Restart to update' : 'App updates'} icon={Download}
        value={updateReady ? undefined : updatesValue(status.update)} disabled={!updateReady && (updatesOff || status.update === 'checking')}
        onPress={updateReady
          ? () => Alert.alert('Restart Rally?', 'Finish any unsent edits first.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Restart', onPress: () => { void Updates.reloadAsync().catch(() => Alert.alert('Restart failed', 'Close and reopen Rally to apply the update.')); } }])
          : () => { void downloadUpdate().catch(() => undefined); }} />
    </SettingsGroup>
    <SettingsGroup title="Support">
      <SettingsRow label="Diagnostics" icon={Stethoscope} navigates onPress={openDiagnostics} />
    </SettingsGroup>
    {directory && <SettingsGroup>
      <SettingsRow label="Sign out" icon={LogOut} destructive onPress={() => Alert.alert('Sign out of Rally?', undefined, [{ text: 'Cancel', style: 'cancel' }, { text: 'Sign out', style: 'destructive', onPress: signOut }])} />
    </SettingsGroup>}
    {version && <Text style={[styles.version, { color: colors.muted }]}>Rally {version}</Text>}
  </ScrollView>;
}

function notificationsValue(permission: string, registration: string): string {
  if (permission === 'unavailable') return 'Unavailable';
  if (permission === 'off in system settings') return 'Off';
  if (permission === 'not requested') return 'Turn on';
  if (registration === 'registration failed') return 'Try again';
  if (registration === 'registering') return 'Connecting…';
  return 'On';
}
function notificationsFooter(permission: string, registration: string, signedIn: boolean): string | undefined {
  if (permission === 'not requested' && !signedIn) return 'Sign in to turn on notifications.';
  if (permission === 'off in system settings') return 'Notifications are off for Rally in the Settings app.';
  if (registration === 'registration failed') return 'This device couldn’t register for notifications.';
  return undefined;
}
function updatesValue(update: ReturnType<typeof useRuntimeStatus>['update']): string {
  switch (update) {
    case 'development': return 'Release builds';
    case 'checking': return 'Checking…';
    case 'failed': return 'Try again';
    case 'current': return 'Up to date';
    default: return 'Check now';
  }
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 40 },
  identity: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, paddingVertical: 14 },
  avatar: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' },
  initial: { fontSize: 22, fontWeight: '600' },
  name: { fontSize: 19, fontWeight: '600' },
  version: { textAlign: 'center', fontSize: 13, marginTop: -8 },
});
