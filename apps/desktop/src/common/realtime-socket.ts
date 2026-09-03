import { z } from 'zod';
import { WebSocketUrlSchema } from '@rally/contracts/url-schemas';
import {
  REALTIME_SOCKET_ID_PATTERN,
  validWebSocketCloseCode,
  validWebSocketCloseReason,
} from './realtime-socket-validation';

export const RALLY_RENDERER_ORIGIN = 'app://rallywithai';

export const DesktopRealtimeSocketKindSchema = z.enum([
  'workstream_control',
  'substream_feed',
]);
export type DesktopRealtimeSocketKind = z.infer<typeof DesktopRealtimeSocketKindSchema>;

export const DesktopRealtimeSocketHandshakePhaseSchema = z.enum([
  'proxy_resolution',
  'dns',
  'tcp',
  'tls',
  'edge_upgrade',
  'proxy_connect_tls_edge',
  'route_failed',
]);
export type DesktopRealtimeSocketHandshakePhase = z.infer<
  typeof DesktopRealtimeSocketHandshakePhaseSchema
>;

const DesktopRealtimeSocketIdSchema = z.string().regex(REALTIME_SOCKET_ID_PATTERN);

export const DesktopRealtimeSocketOpenInputSchema = z.object({
  socketId: DesktopRealtimeSocketIdSchema,
  kind: DesktopRealtimeSocketKindSchema,
  url: WebSocketUrlSchema,
  protocols: z.tuple([
    z.string().min(1).max(100),
    z.string().min(20).max(4_000),
  ]),
}).strict();
export type DesktopRealtimeSocketOpenInput = z.infer<typeof DesktopRealtimeSocketOpenInputSchema>;

export const DesktopRealtimeSocketSendInputSchema = z.object({
  socketId: DesktopRealtimeSocketIdSchema,
  data: z.string(),
}).strict();
export type DesktopRealtimeSocketSendInput = z.infer<typeof DesktopRealtimeSocketSendInputSchema>;

export const DesktopRealtimeSocketCloseInputSchema = z.object({
  socketId: DesktopRealtimeSocketIdSchema,
  code: z.number().int().refine(validWebSocketCloseCode).optional(),
  reason: z.string().refine(validWebSocketCloseReason).optional(),
}).strict();
export type DesktopRealtimeSocketCloseInput = z.infer<typeof DesktopRealtimeSocketCloseInputSchema>;

export const DesktopRealtimeSocketEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('handshake_phase'),
    socketId: DesktopRealtimeSocketIdSchema,
    phase: DesktopRealtimeSocketHandshakePhaseSchema,
    durationMs: z.number().nonnegative(),
    routeIndex: z.number().int().nonnegative(),
    proxied: z.boolean(),
  }).strict(),
  z.object({
    type: z.literal('open'),
    socketId: DesktopRealtimeSocketIdSchema,
    protocol: z.string(),
    extensions: z.string(),
  }).strict(),
  z.object({
    type: z.literal('message'),
    socketId: DesktopRealtimeSocketIdSchema,
    data: z.string(),
  }).strict(),
  z.object({
    type: z.literal('error'),
    socketId: DesktopRealtimeSocketIdSchema,
  }).strict(),
  z.object({
    type: z.literal('close'),
    socketId: DesktopRealtimeSocketIdSchema,
    code: z.number().int(),
    reason: z.string(),
    wasClean: z.boolean(),
  }).strict(),
]);
export type DesktopRealtimeSocketEvent = z.infer<typeof DesktopRealtimeSocketEventSchema>;
