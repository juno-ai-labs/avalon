export interface DurableObjectRpcResult {
  status: number;
  bodyJson: string;
}

/** Preserve legacy HTTP error semantics while callers move to native DO RPC. */
export async function responseToRpcResult(response: Response): Promise<DurableObjectRpcResult> {
  return {
    status: response.status,
    bodyJson: JSON.stringify(await response.json().catch(() => null)),
  };
}

export function rpcResultBody(result: DurableObjectRpcResult): unknown {
  return JSON.parse(result.bodyJson) as unknown;
}

export function rpcResultOk(result: DurableObjectRpcResult): boolean {
  return result.status >= 200 && result.status < 300;
}
