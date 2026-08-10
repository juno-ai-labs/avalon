import type { OnboardingAction, OnboardingSpotlight } from "@avalon/contracts";

/**
 * The onboarding checklist a member sees after their organization exists.
 *
 * Everything about the flow lives in this file: which steps exist, their copy,
 * their order, who sees them, what picking one up does, where the spotlight
 * points, and the query that proves a step is genuinely done. Adding, removing,
 * rewording, or reordering a step is an edit here — no migration, no client
 * change, no new endpoint.
 *
 * Steps are independent by construction. Nothing declares a predecessor, so a
 * member can work through them in any order and the checklist simply reflects
 * whatever they have finished.
 */

export type OnboardingAudienceRole = "owner" | "admin" | "member";

export interface OnboardingSignalContext {
  workspaceId: string;
  userId: string;
}

export interface OnboardingSignal {
  /**
   * Returns at most one row when the step is satisfied. Signals read existing
   * product tables, so a step completes from real work rather than from the
   * client remembering to report it.
   */
  sql: string;
  binds: (context: OnboardingSignalContext) => unknown[];
}

export interface OnboardingStepDefinition {
  id: string;
  title: string;
  description: string;
  action: OnboardingAction;
  spotlight: OnboardingSpotlight | null;
  /** Omit to show the step to everyone. */
  roles?: readonly OnboardingAudienceRole[];
  /** Steps without a signal are resolved only by the member marking them. */
  signal: OnboardingSignal | null;
}

export interface OnboardingCatalog {
  /**
   * Bump whenever the visible set of steps changes. A member who dismissed an
   * older catalog is shown the new one; a member who dismissed this one stays
   * undisturbed.
   */
  version: string;
  title: string;
  completionTitle: string;
  completionBody: string;
  steps: readonly OnboardingStepDefinition[];
}

export const onboardingCatalog: OnboardingCatalog = {
  version: "2026-08-10.1",
  title: "Get started with Avalon",
  completionTitle: "You're set up",
  completionBody: "Avalon is connected, automated, and shared with your team.",
  steps: [
    {
      id: "connect-tools",
      title: "Connect your tools",
      description: "Bring Linear, GitHub, and Google Workspace into Avalon",
      action: { kind: "open_settings", section: "connections" },
      spotlight: {
        anchor: "settings-connections",
        title: "Connect your first tool",
        body: "Pick a provider here. Personal connections act as you; workspace connections are shared with every member and automation.",
        placement: "right",
      },
      signal: {
        sql: `SELECT 1 FROM connector_connections
              WHERE workspace_id = ? AND status != 'disabled'
                AND (scope = 'workspace' OR owner_user_id = ?)
              LIMIT 1`,
        binds: ({ workspaceId, userId }) => [workspaceId, userId],
      },
    },
    {
      id: "create-automation",
      title: "Create your first automation",
      description: "Schedule a recurring brief, monitor, or follow-up",
      action: { kind: "navigate", path: "/automations/new" },
      spotlight: {
        anchor: "sidebar-new-automation",
        title: "Describe the automation you want",
        body: "Say what should happen and how often. Avalon drafts the automation and asks you to confirm before it runs.",
        placement: "right",
      },
      signal: {
        sql: "SELECT 1 FROM automation_subscriptions WHERE workspace_id = ? LIMIT 1",
        binds: ({ workspaceId }) => [workspaceId],
      },
    },
    {
      id: "invite-teammate",
      title: "Invite a teammate",
      description: "Work together in a shared work stream",
      action: { kind: "open_settings", section: "workspace" },
      roles: ["owner", "admin"],
      spotlight: {
        anchor: "settings-invite-teammate",
        title: "Send an invitation",
        body: "Invite by email and choose a role. They join this organization in the same data region.",
        placement: "top",
      },
      signal: {
        sql: `SELECT 1 FROM workspace_invitations WHERE workspace_id = ?
              UNION ALL
              SELECT 1 FROM workspace_members
              WHERE workspace_id = ? AND user_id != ? AND status = 'active'
              LIMIT 1`,
        binds: ({ workspaceId, userId }) => [workspaceId, workspaceId, userId],
      },
    },
  ],
};

export function onboardingStepsForRole(
  role: OnboardingAudienceRole,
  catalog: OnboardingCatalog = onboardingCatalog,
): readonly OnboardingStepDefinition[] {
  return catalog.steps.filter((step) => !step.roles || step.roles.includes(role));
}
