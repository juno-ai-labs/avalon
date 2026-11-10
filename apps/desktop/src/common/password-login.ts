import { PasswordLoginRequestSchema, type PasswordLoginRequest } from '@rally/contracts/password-login';
import { zodDiagnosticCode } from '@rally/contracts/zod-diagnostics';

/** IPC carries declared field diagnostics, never rejected values or raw Zod JSON. */
export function parsePasswordLoginRequest(input: unknown): PasswordLoginRequest {
  const parsed = PasswordLoginRequestSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new Error(zodDiagnosticCode(parsed.error, 'password_login_request')!);
}

export function passwordLoginErrorMessage(message: string): string {
  const detail = message.replace(
    /^Error invoking remote method 'auth:password': (?:RallyApiResponseError|Error): /u, '',
  );
  if (detail.startsWith('password_login_request_invalid:email:')) return 'Enter a valid email address.';
  if (detail.startsWith('password_login_request_invalid:password:')) return 'Enter a password.';
  if (detail.startsWith('password_login_request_invalid:')) return 'Check your email and password.';
  return detail;
}
