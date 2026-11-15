import { useMemo, useRef } from 'react';
import { PanResponder, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { EDGE_SWIPE_WIDTH, edgeSwipeCompletes } from './edge-swipe';

/**
 * A thin strip along the leading edge that calls `onSwipe` once a pan from it
 * moves inward. It sits above the content, so touches that start in it never
 * reach the page beneath; the strip stays narrower than the content's margin.
 * Hidden from accessibility: the header's sidebar button is that route.
 */
export function EdgeSwipe({ onSwipe }: { onSwipe: () => void }) {
  const insets = useSafeAreaInsets();
  const latest = useRef(onSwipe);
  latest.current = onSwipe;
  const fired = useRef(false);
  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderGrant: () => { fired.current = false; },
    onPanResponderMove: (_, gesture) => {
      if (fired.current || !edgeSwipeCompletes(gesture.dx, gesture.dy, gesture.vx)) return;
      fired.current = true;
      latest.current();
    },
    onPanResponderTerminationRequest: () => false,
  }), []);
  return <View {...responder.panHandlers} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
    style={[styles.strip, { width: insets.left + EDGE_SWIPE_WIDTH }]} />;
}

const styles = StyleSheet.create({ strip: { position: 'absolute', left: 0, top: 0, bottom: 0 } });
