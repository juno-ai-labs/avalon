import { z } from 'zod';
import { deferredZodSchema } from "./deferred-zod-schema";

/** Password bytes are never trimmed or normalized. Only the login address is. */
export const PasswordLoginRequestSchema = deferredZodSchema(() => z.strictObject({
  email: z.string().trim().email().transform((email) => email.toLowerCase()),
  password: z.string().min(1),
}));
export type PasswordLoginRequest = z.infer<typeof PasswordLoginRequestSchema>;
