import {
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
  const version = Number.parseInt(declared, 10);
  if (!Number.isFinite(version) || version < MINIMUM_SERVED_CLIENT_CONTRACT) {
    throw clientUpdateRequired();
  }
}

function clientUpdateRequired(): ApiError {
  return new ApiError(
    426,
    "client_update_required",
    "This version of Rally can no longer read this workspace. Update Rally to continue.",
  );
}
