import type { TerminalObjectPort } from "../../durable-objects/workstream-terminal-protocol";
import { observeTerminalSandbox, type TerminalSandboxProvider, type TerminalSandboxSnapshot } from "./provider-contract";

/** The shared readback path for acquisition, webhooks and scheduled reconciliation. */
export async function refreshTerminalProviderObservation(
  terminal: TerminalObjectPort,
  provider: Pick<TerminalSandboxProvider, "getSandbox">,
  identity: { sandboxId: string; generation: number },
): Promise<TerminalSandboxSnapshot | null> {
  const requestId = await terminal.beginProviderObservation(identity);
  if (!requestId) throw new Error("terminal_observation_generation_superseded");
  let snapshot: TerminalSandboxSnapshot | null;
  try {
    snapshot = await observeTerminalSandbox(provider, identity.sandboxId);
  } catch (error) {
    await terminal.settleProviderObservation({
      ...identity, requestId, state: null, recoverable: null, errorCode: "provider_unavailable",
    });
    throw error;
  }
  await terminal.settleProviderObservation({
    ...identity, requestId, state: snapshot?.state ?? "absent",
    recoverable: snapshot?.recoverable ?? null, errorCode: null,
  });
  // The caller's own mutation lease still governs lifecycle decisions. An overlapping
  // observation may supersede this stored result without invalidating that lease.
  return snapshot;
}
