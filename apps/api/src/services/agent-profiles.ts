import type { HarnessPlugin, HarnessSkill } from "@rally/agent-harness";
import type { AgentModelRole, WorkstreamWorkflowInput } from "@rally/contracts";

import type { Env } from "../env";

import type { DesktopActionExecutor } from "./desktop-actions/executor";

/**
 * A conversation that does one fixed job rather than a person's open-ended
 * work: what it is told, which model role routes it, the exact tools it
 * has, and the skills it may load.
 *
 * Stored on the conversation when it is provisioned and read by every run of
 * it, so a profile cannot change under a running conversation, and a run that
 * finds one gets nothing else: not the work-stream prompt, not the built-in or
 * connector plugins, not plugin discovery, not any skill it does not name. A
 * skill is instructions only, never a tool, so naming one keeps the surface as
 * narrow as before. A narrow surface is the
 * point — a conversation-import run drives a signed-in browser over page
 * content that may carry instructions, and the only Rally effect it can reach
 * is the one its desktop performs for it.
 */
export interface AgentProfile {
  role: AgentModelRole;
  systemPrompt(): string;
  /** Always-active plugins; the run's whole tool surface. */
  plugins(input: WorkstreamWorkflowInput, desktop: DesktopActionExecutor | undefined): HarnessPlugin[];
  /** The skills its catalog offers; each still loads only when the model asks. */
  skills: readonly HarnessSkill[];
  /**
   * Cleanup owed once a run of it has ended, however it ended. A run started
   * by a person names them; it runs after the run's outcome is durable.
   */
  ended?(env: Env, run: { workspaceId: string; parentId: string; userId: string | null }): Promise<void>;
}

/**
 * Every profile. The one there was, `session_import`, read a person's AI chat
 * into a Thread, and went with Threads (plan step C-2); a conversation stored
 * with it is refused as `agent_profile_unknown`.
 */
export const AGENT_PROFILES = {
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
