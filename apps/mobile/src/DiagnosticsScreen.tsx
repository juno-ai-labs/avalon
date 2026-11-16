import { useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Network from 'expo-network';
import * as BackgroundTask from 'expo-background-task';
import { useRuntimeStatus, diagnosticSummary, shareDiagnostics } from './diagnostics';
import { SettingsGroup, SettingsRow } from './SettingsList';
import { useTheme } from './theme';

/** Content-free technical status, for a person to read or share with support. */
export function DiagnosticsScreen() {
  const { colors } = useTheme();
  const status = useRuntimeStatus();
  const network = Network.useNetworkState();
  const [background, setBackground] = useState<string | null>(null);
  const timing = (metric: 'launch_to_dashboard' | 'pin_tap_to_artifact' | 'artifact_recovery') => {
    const value = status.timings?.[metric];
    return value ? `${value.ms} ms` : '—';
  };
  return <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ backgroundColor: colors.background }} contentContainerStyle={styles.content}>
    <SettingsGroup title="Status">
      <SettingsRow label="Connection" value={network.isConnected === false ? 'Offline' : network.isConnected ? String(network.type).toLowerCase() : 'Checking…'} />
      <SettingsRow label="Background refresh" value={background ?? 'Check'} onPress={() => {
        void BackgroundTask.getStatusAsync().then(
          (value) => setBackground(value === BackgroundTask.BackgroundTaskStatus.Available ? 'Available' : 'Unavailable'),
          () => setBackground('Unknown'));
      }} />
      {status.lastFailure && <SettingsRow label="Last problem" detail={new Date(status.lastFailure.at).toLocaleString()} value={status.lastFailure.code.replaceAll('_', ' ')} />}
    </SettingsGroup>
    <SettingsGroup title="Speed" footer="The latest time for each, against a 500 ms target.">
      <SettingsRow label="Launch to Home" value={timing('launch_to_dashboard')} />
      <SettingsRow label="Pinned tab to page" value={timing('pin_tap_to_artifact')} />
      <SettingsRow label="Recovery after a crash" value={timing('artifact_recovery')} />
    </SettingsGroup>
    <SettingsGroup footer="Includes app versions and technical status only. Never conversations, canvas names or sign-in details.">
      <SettingsRow label="Share diagnostics" onPress={() => { void shareDiagnostics().catch(() => undefined); }} />
    </SettingsGroup>
    <SettingsGroup title="Details">
      <View style={styles.summary}><Text selectable style={[styles.code, { color: colors.muted }]}>{diagnosticSummary()}</Text></View>
    </SettingsGroup>
  </ScrollView>;
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 40 },
  summary: { padding: 16 },
  code: { fontSize: 12, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', lineHeight: 17 },
});
