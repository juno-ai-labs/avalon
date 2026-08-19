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
