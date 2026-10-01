import { renderSessionImportSystemPrompt, type HarnessPlugin } from "@rally/agent-harness";
import type { AgentModelRole, WorkstreamWorkflowInput } from "@rally/contracts";

import { createBrowserPlugin } from "./desktop-actions/browser-plugin";
import type { DesktopActionExecutor } from "./desktop-actions/executor";
import { createSessionImportPlugin } from "./desktop-actions/session-import-plugin";

/**
 * A conversation that does one fixed job rather than a person's open-ended
 * work: what it is told, which model role routes it, and the exact tools it
 * has.
 *
 * Stored on the conversation when it is provisioned and read by every run of
 * it, so a profile cannot change under a running conversation, and a run that
 * finds one gets nothing else: not the work-stream prompt, not the built-in or
 * connector plugins, not plugin discovery or skills. A narrow surface is the
 * point — a conversation-import run drives a signed-in browser over page
 * content that may carry instructions, and the only Rally effect it can reach
 * is the one its desktop performs for it.
 */
export interface AgentProfile {
  role: AgentModelRole;
  systemPrompt(): string;
  /** Always-active plugins; the run's whole tool surface. */
  plugins(input: WorkstreamWorkflowInput, desktop: DesktopActionExecutor | undefined): HarnessPlugin[];
}

export const AGENT_PROFILES = {
  session_import: {
    role: "session_import",
    systemPrompt: renderSessionImportSystemPrompt,
    plugins: (input, desktop) => [
      createBrowserPlugin(input, desktop),
      createSessionImportPlugin(input, desktop),
    ],
  },
} as const satisfies Record<string, AgentProfile>;

export type AgentProfileId = keyof typeof AGENT_PROFILES;

export function isAgentProfileId(value: string): value is AgentProfileId {
  return Object.hasOwn(AGENT_PROFILES, value);
}

/**
 * The profile a stored value names, or null for an ordinary conversation.
 * A value no profile answers to is a defect, not an ordinary conversation:
 * running it with the full surface would hand a narrow job every tool.
 */
export function agentProfileFor(value: string | null | undefined): AgentProfile | null {
  if (value == null) return null;
  if (!isAgentProfileId(value)) {
    throw Object.assign(new Error(`Unknown agent profile ${value}`), { code: "agent_profile_unknown" });
  }
  return AGENT_PROFILES[value];
}
