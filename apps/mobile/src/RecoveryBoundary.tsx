import { captureJavascriptCrash } from './crashes';
import { Component, type ReactNode } from 'react';
import { Button, StyleSheet, Text, View } from 'react-native';
import { recordFailure, shareDiagnostics } from './diagnostics';

export class RecoveryBoundary extends Component<{ children: ReactNode }, { failed: boolean; generation: number }> {
  state = { failed: false, generation: 0 };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error) { recordFailure('shell_render_failed'); captureJavascriptCrash(error, false); }
  render() {
    if (this.state.failed) return <View style={styles.screen}>
      <Text accessibilityRole="header" style={styles.title}>Rally couldn’t open</Text>
      <Text style={styles.copy}>Try reopening the app. If this keeps happening, share diagnostics with support.</Text>
      <Button title="Reopen Rally" onPress={() => this.setState(({ generation }) => ({ failed: false, generation: generation + 1 }))} />
      <Button title="Share diagnostics" onPress={() => { void shareDiagnostics().catch(() => undefined); }} />
    </View>;
    return <View key={this.state.generation} style={{ flex: 1 }}>{this.props.children}</View>;
  }
}
const styles = StyleSheet.create({ screen: { flex: 1, justifyContent: 'center', padding: 32, backgroundColor: '#ffffff' }, title: { fontSize: 24, fontWeight: '600', color: '#17231e' }, copy: { marginVertical: 20, fontSize: 17, lineHeight: 25, color: '#34463b' } });
