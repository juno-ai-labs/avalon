import { useMemo, useRef, type ReactNode } from 'react';
import { Animated, View, type ViewStyle } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { EDGE_SWIPE_ACTIVATION, EDGE_SWIPE_WIDTH } from './edge-swipe';

/** What an edge pull drives: the drawer follows `x` on the native side while
 * the finger is down; `begin` and `end` bracket the pull in JS. */
export interface EdgePullTarget {
  begin: () => void;
  end: (translationX: number, velocityX: number, canceled: boolean) => void;
}

/**
 * Wraps content in a pan that starts only in a strip along the leading edge
 * and activates only once the touch moves inward. Until then the touch belongs
 * to the content beneath, so a tap on the strip still reaches it.
 */
export function EdgePull({ x, target, enabled, style, children }: { x: Animated.Value; target: EdgePullTarget | null; enabled: boolean; style?: ViewStyle; children: ReactNode }) {
  const insets = useSafeAreaInsets();
  // The pull ends on the sidebar it began on, even if focus moved mid-pull and
  // another screen (or none) is registered by release.
  const pulled = useRef<EdgePullTarget | null>(null);
  const onUpdate = useMemo(() => Animated.event([{ nativeEvent: { handlerData: { translationX: x } } }], { useNativeDriver: true }), [x]);
  const pan = usePanGesture({
    enabled: enabled && target !== null,
    hitSlop: { left: 0, width: insets.left + EDGE_SWIPE_WIDTH },
    activeOffsetX: EDGE_SWIPE_ACTIVATION,
    failOffsetY: [-EDGE_SWIPE_ACTIVATION, EDGE_SWIPE_ACTIVATION],
    runOnJS: true,
    useAnimated: true,
    onActivate: () => { pulled.current = target; target?.begin(); },
    onUpdate,
    // Reset the offset even when no sidebar took the pull, so none starts from a stale one.
    onDeactivate: (event) => {
      const started = pulled.current;
      pulled.current = null;
      // A pull whose screen lost focus closes rather than opening over the new one.
      started?.end(event.translationX, event.velocityX, event.canceled || started !== target);
      x.setValue(0);
    },
    // A pan disabled mid-pull (its screen unregistered) may skip onDeactivate;
    // close whatever pull is still open so its Modal does not stay up.
    onFinalize: () => {
      const started = pulled.current;
      pulled.current = null;
      started?.end(0, 0, true);
      x.setValue(0);
    },
  });
  return <GestureDetector gesture={pan}><View collapsable={false} style={style}>{children}</View></GestureDetector>;
}
