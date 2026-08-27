import { z } from 'zod';
import { WebSocketUrlSchema } from '@rally/contracts/url-schemas';

export const RALLY_RENDERER_ORIGIN = 'app://rallywithai';

export const DesktopRealtimeSocketKindSchema = z.enum([
  'workstream_control',
  'substream_feed',
]);
export type DesktopRealtimeSocketKind = z.infer<typeof DesktopRealtimeSocketKindSchema>;

export const DesktopRealtimeSocketOpenInputSchema = z.object({
  socketId: z.uuid(),
  kind: DesktopRealtimeSocketKindSchema,
  url: WebSocketUrlSchema,
  protocols: z.tuple([
    z.string().min(1).max(100),
    z.string().min(20).max(4_000),
  ]),
}).strict();
export type DesktopRealtimeSocketOpenInput = z.infer<typeof DesktopRealtimeSocketOpenInputSchema>;

export const DesktopRealtimeSocketSendInputSchema = z.object({
  socketId: z.uuid(),
  data: z.string(),
}).strict();
export type DesktopRealtimeSocketSendInput = z.infer<typeof DesktopRealtimeSocketSendInputSchema>;

export const DesktopRealtimeSocketCloseInputSchema = z.object({
  socketId: z.uuid(),
  code: z.number().int().optional(),
  reason: z.string().optional(),
}).strict();
export type DesktopRealtimeSocketCloseInput = z.infer<typeof DesktopRealtimeSocketCloseInputSchema>;

export const DesktopRealtimeSocketEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('open'),
    socketId: z.uuid(),
    protocol: z.string(),
    extensions: z.string(),
  }).strict(),
  z.object({
    type: z.literal('message'),
    socketId: z.uuid(),
    data: z.string(),
  }).strict(),
  z.object({
    type: z.literal('error'),
    socketId: z.uuid(),
  }).strict(),
  z.object({
    type: z.literal('close'),
    socketId: z.uuid(),
    code: z.number().int(),
    reason: z.string(),
    wasClean: z.boolean(),
  }).strict(),
]);
export type DesktopRealtimeSocketEvent = z.infer<typeof DesktopRealtimeSocketEventSchema>;
