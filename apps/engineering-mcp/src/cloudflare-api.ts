import { codeShaped } from "@rally/contracts/zod-diagnostics";

/** A Cloudflare API failure, with the code its log names it by. */
export class CloudflareQueryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CloudflareQueryError";
  }
}

type CloudflareEnvelope = {
  success?: boolean;
  errors?: Array<{ code?: number | string; message?: string }>;
  result?: unknown;
};

/**
 * Cloudflare's `result` from a v4-style envelope, or a refusal coded
 * `<failure>:<code>`, where the code is Cloudflare's own or `http_<status>`
 * when the response carried none. The message keeps Cloudflare's codes and
 * text for the engineer; only the code reaches the log.
 */
export async function cloudflareResult(response: Response, failure: string): Promise<unknown> {
  const body = await response.json().catch(() => null) as CloudflareEnvelope | null;
  if (response.ok && body?.success === true) return body.result;
  const first = body?.errors?.[0];
  const code = first?.code === undefined ? `http_${response.status}` : codeShaped(String(first.code));
  throw new CloudflareQueryError(
    `${failure}:${code}`,
    body?.errors?.length
      ? body.errors.map((error) => `${error.code ?? "error"}: ${error.message ?? ""}`).join("\n")
      : `Cloudflare returned HTTP ${response.status}`,
  );
}
