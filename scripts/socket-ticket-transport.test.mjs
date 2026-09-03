import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * The local drivers run from the repository root with plain Node, which
 * resolves no workspace package, so their shared helper repeats the socket-ticket
 * transport constants instead of importing them. A copy that drifts would let
 * the acceptance check pass while exercising a transport the client no longer
 * speaks, so pin the two together here.
 */
const contracts = readFileSync(new URL("../packages/contracts/src/socket-tickets.ts", import.meta.url), "utf8");
const socketClient = readFileSync(new URL("./substream-socket-client.mjs", import.meta.url), "utf8");
const smoke = readFileSync(new URL("./smoke-local.mjs", import.meta.url), "utf8");
const smokeModel = readFileSync(new URL("./smoke-model.mjs", import.meta.url), "utf8");
const e2e = readFileSync(new URL("./e2e-local.mjs", import.meta.url), "utf8");

function declaration(source, name) {
  return new RegExp(`${name} = "([^"]+)"`).exec(source)?.[1] ?? null;
}

test("the smoke check speaks the subprotocol the contracts package defines", () => {
  for (const name of ["SOCKET_TICKET_SUBPROTOCOL", "SOCKET_TICKET_QUERY_PARAM"]) {
    const expected = declaration(contracts, name);
    assert.ok(expected, `${name} is not declared in packages/contracts/src/socket-tickets.ts`);
    assert.equal(
      declaration(socketClient, name),
      expected,
      `${name} in scripts/substream-socket-client.mjs drifted from the contracts package`,
    );
  }
});

test("the local drivers open command sockets without a ticket in the URL", () => {
  assert.match(smoke, /socketUrlWithoutTicket\(ticket\.body\.url\)/u);
  assert.match(smoke, /protocols: socketTicketProtocols\(ticket\.body\.ticket\)/u);
  assert.match(smoke, /firstSocket\.negotiated === SOCKET_TICKET_SUBPROTOCOL/u);
  assert.match(e2e, /socketUrlWithoutTicket\(ticket\.body\.url\)/u);
  assert.match(e2e, /protocols: socketTicketProtocols\(ticket\.body\.ticket\)/u);
});

test("the local drivers submit child-local mutations over the substream socket", () => {
  assert.doesNotMatch(smoke, /\/messages(?:\?|`)/u);
  assert.doesNotMatch(smokeModel, /\/messages(?:\?|`)/u);
  assert.doesNotMatch(e2e, /\/messages`/u);
  assert.doesNotMatch(e2e, /\/stop`/u);
  assert.match(smoke, /type: "create_message"/u);
  assert.match(e2e, /type: "create_message"/u);
  assert.match(e2e, /type: "stop_harness"/u);
});
