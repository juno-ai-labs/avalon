import { z } from 'zod';

/** Password bytes are never trimmed or normalized. Only the login address is. */
export const PasswordLoginRequestSchema = z.strictObject({
  email: z.string().trim().email().transform((email) => email.toLowerCase()),
  password: z.string().min(1),
});
export type PasswordLoginRequest = z.infer<typeof PasswordLoginRequestSchema>;
