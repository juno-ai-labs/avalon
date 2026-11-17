/**
 * The source-decision page's decisions, apart from React so they can be
 * tested: what an emailed link's fragment asks for, and what the page says
 * once Rally has answered. See `docs/browser-client.md#answering-a-source-request-from-email`.
 */
import { SourceDecisionLinkSchema, type SourceDecisionLink, type SourceDecisionResult } from "@rally/contracts/browser-session";
import { ConfiguredRegionSchema } from "@rally/contracts/regions";

import { BrowserApiError } from "./transport";

/** What a link asks for: the deployment that holds the request, and the signed decision to post there. */
export interface SourceDecisionAsk {
  region: string;
  link: SourceDecisionLink;
}

/**
 * The decision an emailed link's fragment carries, or null when the fragment
 * is not one: opened without it, cut short by a mail client, or reloaded
 * after the page dropped it from history.
 */
export function sourceDecisionAsk(hash: string): SourceDecisionAsk | null {
  const fields = new URLSearchParams(hash.replace(/^#/u, ""));
  const region = ConfiguredRegionSchema.safeParse(fields.get("region"));
  const link = SourceDecisionLinkSchema.safeParse({
    workspaceId: fields.get("workspace"), sidekickId: fields.get("sidekick"), requestId: fields.get("request"),
    userId: fields.get("person"), decision: fields.get("decision"), token: fields.get("token"),
  });
  return region.success && link.success ? { region: region.data, link: link.data } : null;
}

export interface SourceDecisionWords {
  title: string;
  message: string;
  /** What was asked, under the message: the events and the person's condition. Empty when there is nothing to add. */
  detail: string;
}

function asked(result: SourceDecisionResult): string {
  const events = result.eventLabels.length > 0 ? `Events: ${result.eventLabels.join(", ")}` : "";
  const condition = result.condition ? `Only when: ${result.condition}` : "";
  return [events, condition].filter((part) => part !== "").join(". ");
}

/**
 * What the page says once the link was posted. A link that did what it asked
 * says so, the first time and every later time it is opened. One that found
 * the request already answered the other way, or replaced by a newer ask,
 * says how the request stands and that nothing changed.
 */
export function sourceDecisionWords(result: SourceDecisionResult): SourceDecisionWords {
  const detail = asked(result);
  if (result.applied && result.state === "approved") {
    return { title: "Approved", message: `Events from your ${result.connectorName} can now start ${result.sidekickName}.`, detail };
  }
  if (result.applied && result.state === "declined") {
    return { title: "Declined", message: `Events from your ${result.connectorName} will not start ${result.sidekickName}.`, detail: "" };
  }
  if (result.state === "approved") {
    return { title: "Already approved", message: `You already approved this request, so this link changed nothing. Events from your ${result.connectorName} can start ${result.sidekickName}.`, detail };
  }
  if (result.state === "declined") {
    return { title: "Already declined", message: `You already declined this request, so this link changed nothing. ${result.requestedByName} can ask you again.`, detail: "" };
  }
  if (result.state === "cancelled") {
    return { title: "This request was replaced", message: `${result.requestedByName} asked again after this email was sent, so this link changed nothing. Use the newest email from Rally, or answer in Rally under Activity.`, detail: "" };
  }
  return { title: "Not answered yet", message: "Rally could not record your answer. Open the link from your email again, or answer in Rally under Activity.", detail: "" };
}

export interface SourceDecisionFailure {
  title: string;
  message: string;
}

/** What the page says when the link could not be posted or Rally refused it. */
export function sourceDecisionFailure(cause: unknown): SourceDecisionFailure {
  if (cause instanceof BrowserApiError) {
    // An account to connect is the request's first step, which only Rally can take: the link cannot.
    if (cause.code === "sidekick_source_connection_missing" || cause.code === "sidekick_source_connection_reconnect") {
      const reconnect = cause.code === "sidekick_source_connection_reconnect";
      return { title: reconnect ? "Reconnect your account first" : "Connect your account first",
        message: `${cause.message} Open the request in Rally, in the conversation it was asked from, to ${reconnect ? "reconnect" : "connect"} the account and approve.` };
    }
    // Rally's own sentence says what to do, or that the Sidekick is gone.
    return { title: cause.status === 401 ? "This link is not valid" : "Not answered", message: cause.message };
  }
  // A fetch that never reached Rally throws a TypeError with the browser's
  // own wording, which says nothing a person can act on.
  return { title: "Can't reach Rally", message: "Check your connection, then open the link from your email again." };
}

/** What the page says when the address carries no decision. */
export const SOURCE_DECISION_LINK_MISSING: SourceDecisionFailure = {
  title: "Open the link from your email",
  message: "This page answers a request from the Approve or Decline button in a Rally email. Open that button again, or answer in Rally under Activity.",
};
