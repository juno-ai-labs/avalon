import {
  GUEST_WORKSPACES_CLIENT_CONTRACT,
  MINIMUM_SERVED_CLIENT_CONTRACT,
  RALLY_HEADERS,
  readRallyHeader,
} from "@rally/contracts/http-headers";

import { ApiError } from "./api-error";

/** One request's headers, which is all this decision reads. */
export type ClientRequestHeaders = (name: string) => string | undefined;

/**
 * Refuse a build that would drop the payload this route is about to send.
 *
 * A desktop parses the workspace socket's opening sidebar with a **strict**
 * schema, and a strict schema does not ignore a field it has never heard of —
 * it rejects the whole object — so a build older than
 * `MINIMUM_SERVED_CLIENT_CONTRACT` (the Canvases and Sidekicks pivot) would
 * render an empty sidebar and keep asking for it. `426` is the honest answer.
 *
 * **A request with no `Origin` is admitted.** That is not a loophole; it is the
 * discriminator. The desktop renderer runs in a browser context at its own
 * origin and therefore always sends one, and it is the only client whose
 * decoders are strict. The iOS client and the main process decode with
 * `Codable` and with schemas that ignore unknown keys, so the new payload costs
 * them nothing, and refusing them would break working clients in order to
 * protect them from a problem they do not have.
 *
 * Reached from the one surface the sidebar travels on, the workspace socket
 * ticket, rather than from a middleware: a build that cannot render the
 * sidebar can still be signed in and still reach the updater.
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
