import {
  ARTIFACT_UPDATES_CLIENT_CONTRACT,
  NEW_MESSAGES_CLIENT_CONTRACT,
  CHANNEL_MERGES_CLIENT_CONTRACT,
  CHANNEL_MESSAGES_CLIENT_CONTRACT,
  CHANNEL_PRIVATE_MERGES_CLIENT_CONTRACT,
  GUEST_WORKSPACES_CLIENT_CONTRACT,
  INDIVIDUAL_SPACE_CLIENT_CONTRACT,
  MINIMUM_SERVED_CLIENT_CONTRACT,
  SESSION_IMPORT_CLIENT_CONTRACT,
  PENDING_ACCESS_REQUESTS_CLIENT_CONTRACT,
  RALLY_HEADERS,
  readRallyHeader,
} from "@rally/contracts/http-headers";

import { ApiError } from "./api-error";

/** One request's headers, which is all this decision reads. */
export type ClientRequestHeaders = (name: string) => string | undefined;

/**
 * Refuse a build that would drop the payload this route is about to send.
 *
 * The Spaces cutover changed two payloads a shipped desktop parses with
 * **strict** schemas: the workspace socket's opening sidebar, which now carries
 * both Space directories, and the Channel rows inside it, which now carry their
 * placements. A strict schema does not ignore a field it has never heard of —
 * it rejects the whole object — so a pre-cutover build reaching a
 * post-cutover Worker renders an empty sidebar and keeps asking for it. `426`
 * is the honest answer, and the PRD's rollout asks for exactly that: "Older
 * Project clients receive an explicit update-required response rather than a
 * malformed or partial Project payload."
 *
 * **A request with no `Origin` is admitted.** That is not a loophole; it is the
 * discriminator. The desktop renderer runs in a browser context at its own
 * origin and therefore always sends one, and it is the only client whose
 * decoders are strict. The iOS client and the main process decode with
 * `Codable` and with schemas that ignore unknown keys, so the new payload costs
 * them nothing, and refusing them would break working clients in order to
 * protect them from a problem they do not have.
 *
 * Reached from the two surfaces the changed payloads travel on rather than from
 * a middleware: a build that cannot render the sidebar can still be signed in,
 * still post a message, and still be told to update.
 */
export function requireCurrentClientContract(header: ClientRequestHeaders): void {
  const declared = readRallyHeader(header, RALLY_HEADERS.CLIENT_CONTRACT);
  if (declared === undefined) {
    if (header("origin") === undefined) return;
    throw clientUpdateRequired();
  }
  if (!/^\d+$/u.test(declared)) throw clientUpdateRequired();
  const version = Number(declared);
  if (!Number.isSafeInteger(version) || version < MINIMUM_SERVED_CLIENT_CONTRACT) {
    throw clientUpdateRequired();
  }
}

function clientUpdateRequired(): ApiError {
  return new ApiError(
    426,
    "client_update_required",
    "This version of Rally can no longer read this organization. Update Rally to continue.",
  );
}

/** Import tools require a matching desktop before any Channel or run is reserved. */
export function requireSessionImportClientContract(header: ClientRequestHeaders): void {
  const declared = readRallyHeader(header, RALLY_HEADERS.CLIENT_CONTRACT);
  if (declared === undefined || !/^\d+$/u.test(declared)
    || !Number.isSafeInteger(Number(declared)) || Number(declared) < SESSION_IMPORT_CLIENT_CONTRACT) {
    throw new ApiError(426, "client_update_required", "Update Rally to import conversations with this version of the browser tools.");
  }
}

/**
 * Whether this client opens a guest relationship. A desktop build before the
 * guest contract asks member-only routes (attention, push registration, the
 * Channel list) with every stored credential, and one guest's refusal fails
 * the rest, so platform discovery does not offer it one.
 */
export function clientOpensGuestWorkspaces(header: ClientRequestHeaders): boolean {
  const declared = readRallyHeader(header, RALLY_HEADERS.CLIENT_CONTRACT);
  return declared !== undefined && /^\d+$/u.test(declared)
    && Number(declared) >= GUEST_WORKSPACES_CLIENT_CONTRACT;
}

/**
 * The contract this request declares, or zero for one that declares none or
 * something unreadable: every build that sends nothing predates the header.
 */
export function declaredClientContract(header: ClientRequestHeaders): number {
  const declared = readRallyHeader(header, RALLY_HEADERS.CLIENT_CONTRACT);
  if (declared === undefined || !/^\d+$/u.test(declared)) return 0;
  const version = Number(declared);
  return Number.isSafeInteger(version) ? version : 0;
}

/**
 * Whether this client reads a Space scoped `individual`. A native client that
 * declares nothing decodes Space payloads loosely or not at all, so only a
 * browser-context build (one with an `Origin`) is held to its contract, as in
 * {@link requireCurrentClientContract}.
 */
export function clientReadsIndividualSpaces(header: ClientRequestHeaders): boolean {
  return clientReads(header, INDIVIDUAL_SPACE_CLIENT_CONTRACT);
}

/** Whether this client reads a Channel feed item of kind `message`; the same rule. */
export function clientReadsChannelMessages(header: ClientRequestHeaders): boolean {
  return clientReads(header, CHANNEL_MESSAGES_CLIENT_CONTRACT);
}

/** Whether this client reads a Channel message's `merge` and a message item's ordinal; the same rule. */
export function clientReadsChannelMerges(header: ClientRequestHeaders): boolean {
  return clientReads(header, CHANNEL_MERGES_CLIENT_CONTRACT);
}

/** Whether this client reads an Activity row of kind `artifact_updated`; the same rule. */
export function clientReadsArtifactUpdates(header: ClientRequestHeaders): boolean {
  return clientReads(header, ARTIFACT_UPDATES_CLIENT_CONTRACT);
}

/** Whether this client reads a Channel merge's `private`; the same rule. */
export function clientReadsPrivateChannelMerges(header: ClientRequestHeaders): boolean {
  return clientReads(header, CHANNEL_PRIVATE_MERGES_CLIENT_CONTRACT);
}

function clientReads(header: ClientRequestHeaders, contract: number): boolean {
  if (readRallyHeader(header, RALLY_HEADERS.CLIENT_CONTRACT) === undefined && header("origin") === undefined) return true;
  return declaredClientContract(header) >= contract;
}

/** Whether this build reads human reply Activity rows. */
export function clientReadsNewMessages(header: ClientRequestHeaders): boolean {
  return clientReads(header, NEW_MESSAGES_CLIENT_CONTRACT);
}

/** Whether the access preview may include request lifecycle fields. */
export function clientReadsPendingAccessRequests(header: ClientRequestHeaders): boolean {
  return clientReads(header, PENDING_ACCESS_REQUESTS_CLIENT_CONTRACT);
}
