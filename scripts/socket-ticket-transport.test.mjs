import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * `scripts/smoke-local.mjs` runs from the repository root with plain Node,
 * which resolves no workspace package, so it repeats the socket-ticket
 * transport constants instead of importing them. A copy that drifts would let
 * the acceptance check pass while exercising a transport the client no longer
 * speaks, so pin the two together here.
 */
const contracts = readFileSync(new URL("../packages/contracts/src/socket-tickets.ts", import.meta.url), "utf8");
const smoke = readFileSync(new URL("./smoke-local.mjs", import.meta.url), "utf8");

function declaration(source, name) {
  return new RegExp(`${name} = "([^"]+)"`).exec(source)?.[1] ?? null;
}

test("the smoke check speaks the subprotocol the contracts package defines", () => {
  for (const name of ["SOCKET_TICKET_SUBPROTOCOL", "SOCKET_TICKET_QUERY_PARAM"]) {
    const expected = declaration(contracts, name);
    assert.ok(expected, `${name} is not declared in packages/contracts/src/socket-tickets.ts`);
    assert.equal(
      declaration(smoke, name),
      expected,
      `${name} in scripts/smoke-local.mjs drifted from the contracts package`,
    );
  }
});

test("the smoke check opens its socket without a ticket in the URL", () => {
  assert.match(smoke, /socketUrlWithoutTicket\(ticket\.body\.url\)/u);
  assert.match(smoke, /protocols: socketTicketProtocols\(ticket\.body\.ticket\)/u);
  assert.match(smoke, /firstSocket\.negotiated === SOCKET_TICKET_SUBPROTOCOL/u);
});
