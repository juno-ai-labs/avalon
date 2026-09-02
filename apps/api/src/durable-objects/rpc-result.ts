export interface DurableObjectRpcResult {
  status: number;
  bodyJson: string;
}

/** Preserve legacy HTTP error semantics while callers move to native DO RPC. */
export async function responseToRpcResult(response: Response): Promise<DurableObjectRpcResult> {
  const text = await response.text();
  let bodyJson: string;
  try {
    bodyJson = JSON.stringify(JSON.parse(text));
  } catch {
    bodyJson = JSON.stringify({
      error: text.slice(0, 2_000) || `HTTP ${response.status}`,
    });
  }
  return {
    status: response.status,
    bodyJson,
  };
}

export function rpcResultBody(result: DurableObjectRpcResult): unknown {
  return JSON.parse(result.bodyJson) as unknown;
}

export function rpcResultOk(result: DurableObjectRpcResult): boolean {
  return result.status >= 200 && result.status < 300;
}

/**
 * What one object-port endpoint decided, before it is given a shape.
 *
 * A `Response` is the right answer for the `fetch` path and pure overhead for
 * the RPC one, which is how every port call made from inside the object
 * arrives. Keeping the decision separate lets each entry point pay only for
 * what it needs.
 */
export interface ObjectPortOutcome {
  status: number;
  payload: unknown;
}

/** An object-port outcome as an RPC result, with no `Response` in between. */
export function objectPortRpcResult(outcome: ObjectPortOutcome): DurableObjectRpcResult {
  return { status: outcome.status, bodyJson: JSON.stringify(outcome.payload) };
}

/** A JSON `Response`, the shape both the HTTP port and `responseToRpcResult` take. */
export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}
