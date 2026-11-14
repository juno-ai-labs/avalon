import { useMemo, useRef, type ReactNode } from 'react';
import { PanResponder, Pressable, View, type GestureResponderEvent, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from './theme';

interface Props {
  title: string;
  disabled: boolean;
  style: StyleProp<ViewStyle>;
  destinationStyle: StyleProp<ViewStyle>;
  onOpen: () => void;
  onStart: (x: number, y: number) => void;
  onMove: (x: number, y: number) => void;
  onEnd: () => void;
  onCancel: () => void;
  onEarlier?: () => void;
  onLater?: () => void;
  order?: { index: number; count: number };
  handle: boolean;
  children: ReactNode;
  controls: ReactNode;
}

/** Pressable owns the long press; PanResponder takes over only once armed. */
export function SidebarDragRow(props: Props) {
  const { colors } = useTheme();
  const latest = useRef(props);
  latest.current = props;
  const armed = useRef(false);
  const panning = useRef(false);
  const suppressOpen = useRef(false);
  const start = (event: GestureResponderEvent) => {
    if (latest.current.disabled) return;
    armed.current = true;
    suppressOpen.current = true;
    latest.current.onStart(event.nativeEvent.pageX, event.nativeEvent.pageY);
  };
  const responders = useMemo(() => {
    const finish = (cancelled = false) => {
      if (armed.current) {
        armed.current = false;
        if (cancelled) latest.current.onCancel(); else latest.current.onEnd();
      }
      panning.current = false;
    };
    const shared = {
      onPanResponderMove: (_: GestureResponderEvent, gesture: { moveX: number; moveY: number }) => latest.current.onMove(gesture.moveX, gesture.moveY),
      onPanResponderRelease: () => finish(),
      onPanResponderTerminate: () => finish(true),
      onPanResponderTerminationRequest: () => !armed.current,
    };
    return {
      finish,
      row: PanResponder.create({ ...shared,
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponderCapture: () => armed.current,
        onPanResponderGrant: () => { panning.current = true; },
      }),
      handle: PanResponder.create({ ...shared,
        onStartShouldSetPanResponder: () => !latest.current.disabled,
        onPanResponderGrant: (event) => {
          armed.current = true;
          panning.current = true;
          suppressOpen.current = true;
          latest.current.onStart(event.nativeEvent.pageX, event.nativeEvent.pageY);
        },
      }),
    };
  }, []);
  return <View {...responders.row.panHandlers} style={props.style}
    onTouchEnd={() => { if (!panning.current) responders.finish(); }}
    onTouchCancel={() => responders.finish(true)}>
    <Pressable style={props.destinationStyle} accessibilityRole="button" accessibilityLabel={props.title}
      accessibilityHint="Use Edit in Pinned to pin, unpin, or reorder"
      onPressIn={() => { suppressOpen.current = false; }} onLongPress={start}
      onPress={() => { if (!suppressOpen.current) props.onOpen(); }}>
      {props.children}
    </Pressable>
    {props.controls}
    {props.handle && <View {...responders.handle.panHandlers} accessible accessibilityRole="adjustable"
      accessibilityLabel={`Reorder ${props.title}`} accessibilityHint="Drag to move, or use the move actions"
      accessibilityValue={props.order ? { min: 1, max: props.order.count, now: props.order.index + 1, text: `Pinned tab ${props.order.index + 1} of ${props.order.count}` } : undefined}
      accessibilityActions={[...(props.onEarlier ? [{ name: 'decrement' as const, label: 'Move earlier' }] : []), ...(props.onLater ? [{ name: 'increment' as const, label: 'Move later' }] : [])]}
      onAccessibilityAction={({ nativeEvent }) => {
        if (nativeEvent.actionName === 'decrement') props.onEarlier?.();
        if (nativeEvent.actionName === 'increment') props.onLater?.();
      }} style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center' }}>
      <Ionicons name="reorder-two" size={22} color={colors.muted} />
    </View>}
  </View>;
}
