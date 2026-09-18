import { describeZodIssues } from "@rally/contracts/zod-diagnostics";
import { z } from "zod";
import { ConfiguredRegionSchema } from "@rally/contracts/regions";

export class BrowserApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const ErrorSchema = z.object({ error: z.object({ message: z.string() }) });

/** Cookies remain HttpOnly; every request explicitly names its deployment. */
export async function browserRequest<T>(region: string, path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
  ConfiguredRegionSchema.parse(region);
  // Chrome serializes cookie writers across tabs. Keep this off all product
  // reads/mutations: an old renewal must finish before a newer login/logout.
  const send = () => request<T>(region, path, schema, body);
  if (['/session/renew', '/email/redeem', '/logout'].includes(path) && navigator.locks) {
    return navigator.locks.request(`rally-browser-cookie:${region}`, send);
  }
  return send();
}

async function request<T>(region: string, path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
  const response = await fetch(`/regional/${region}/browser${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    redirect: "error",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value: unknown = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = ErrorSchema.safeParse(value);
    throw new BrowserApiError(response.status, error.success ? error.data.error.message : "Unable to continue. Please try again.");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`Rally returned an unexpected response (${describeZodIssues(parsed.error)}). Reload and try again.`);
  return parsed.data;
}
