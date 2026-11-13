import { z } from 'zod';
import { RegionSchema } from './regions';

const uuidV7 = z.string().uuid().refine((value) => value[14] === '7');
export const MobileCrashScopeSchema = z.strictObject({
  userId: z.string().uuid(), workspaceId: z.string().uuid(), route: RegionSchema,
});
export type MobileCrashScope = z.infer<typeof MobileCrashScopeSchema>;
export const CrashUploadMetadataSchema = z.strictObject({
  uploadId: uuidV7,
  installationId: uuidV7,
  route: RegionSchema,
  release: z.string().min(1).max(64).regex(/^[a-zA-Z0-9._+-]+$/u),
  buildId: z.string().min(1).max(64).regex(/^[a-zA-Z0-9._+-]+$/u),
  platform: z.enum(['darwin', 'win32', 'linux']),
  architecture: z.enum(['arm64', 'x64']),
  processRole: z.enum(['main', 'renderer', 'utility', 'gpu', 'unknown']),
  launchId: uuidV7,
  channel: z.enum(['development', 'alpha', 'beta', 'stable']),
  format: z.enum(['minidump', 'mobile-json']).default('minidump'),
  owner: MobileCrashScopeSchema.optional(),
});
export type CrashUploadMetadata = z.infer<typeof CrashUploadMetadataSchema>;

// Raw text stays in regional R2. Only these closed/numeric fields may become
// an external issue summary; exception messages and filenames never do.
export const MobileCrashPayloadSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('ios-native'),
    report: z.string(),
    signal: z.enum(['SIGABRT', 'SIGBUS', 'SIGFPE', 'SIGILL', 'SIGSEGV', 'SIGTRAP', 'SIGSYS', 'SIGPIPE', 'unknown']),
    threads: z.array(z.strictObject({
      crashed: z.boolean(),
      frames: z.array(z.strictObject({
        imageUUID: z.string().regex(/^[a-fA-F0-9-]+$/u),
        offset: z.string().regex(/^[a-fA-F0-9]+$/u),
      })),
    })),
  }),
  z.strictObject({
    kind: z.literal('hermes'),
    report: z.string(),
    fatal: z.boolean(),
    updateId: z.string().uuid().nullable(),
  }),
]);
export type MobileCrashPayload = z.infer<typeof MobileCrashPayloadSchema>;

export const MobileCrashReportSchema = z.strictObject({
  scope: MobileCrashScopeSchema,
  metadata: CrashUploadMetadataSchema,
  payload: MobileCrashPayloadSchema,
  deleteAfter: z.number().finite(),
});
export type MobileCrashReport = z.infer<typeof MobileCrashReportSchema>;
