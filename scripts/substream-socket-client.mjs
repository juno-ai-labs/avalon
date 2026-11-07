import WebSocket from "ws";

// This helper runs from the repository root with plain Node, which resolves no
// workspace package and cannot import the TypeScript contracts source, so
// these are copies of the public contract's values. A drift fails the smoke
// and e2e lanes that use this helper, at the socket handshake.
export const SOCKET_TICKET_SUBPROTOCOL = "rally.ticket.v1";
export const SOCKET_TICKET_QUERY_PARAM = "ticket";

export function socketTicketProtocols(ticket) {
  return [SOCKET_TICKET_SUBPROTOCOL, ticket];
}

export function socketUrlWithoutTicket(url) {
  const parsed = new URL(url);
  parsed.search = "";
  return parsed.toString();
}

/**
 * Opens one AgentLoopDO feed, optionally submits one correlated command
 * after the canonical snapshot, and returns only after its private receipt.
 */
export function openSubstreamSocket(url, {
  expectOpen,
  protocols,
  command,
  subscriptionBootstrap = false,
  timeoutMs,
}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, protocols ?? [], { origin: "app://rallywithai" });
    let finished = false;
    let snapshotReceived = false;
    let commandResult;
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error(`Realtime check timed out (${expectOpen ? "open" : "replay"})`));
    }, timeoutMs);

    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const fail = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      socket.close();
      reject(error);
    };

    socket.addEventListener("message", (event) => {
      if (!expectOpen) return;
      try {
        const payload = JSON.parse(String(event.data));
        if (payload.type === "snapshot") snapshotReceived = true;
        if ((payload.type === "client_command_succeeded"
          || payload.type === "client_command_failed")
          && command
          && payload.operationId === command.operationId) {
          commandResult = payload;
        }
        if (snapshotReceived && (!command || commandResult)) {
          const negotiated = socket.protocol;
          socket.close(1000, command ? "Command receipt received" : "Smoke check complete");
          finish({
            opened: true,
            snapshot: true,
            negotiated,
            ...(commandResult ? { commandResult } : {}),
          });
        }
      } catch (error) {
        fail(error);
      }
    });
    socket.addEventListener("open", () => {
      if (!expectOpen) {
        socket.close();
        fail(new Error("A consumed realtime ticket was accepted"));
        return;
      }
      if (!subscriptionBootstrap) {
        socket.send(JSON.stringify({ type: "subscribe", afterSequence: 0, publishPresence: false }));
      }
      if (command) socket.send(JSON.stringify(command));
    });
    // `ws` reports the handshake response before erroring, which is the only
    // place the rejection's status is visible. A replay that arrives as a 500
    // satisfies "did not open" exactly as well as a clean 401 does, so the
    // status is the assertion that means something.
    socket.on("unexpected-response", (_request, response) => {
      clearTimeout(timeout);
      socket.terminate();
      if (expectOpen) fail(new Error(`Realtime handshake returned ${response.statusCode}`));
      else finish({ opened: false, snapshot: false, status: response.statusCode });
    });
    socket.addEventListener("error", () => {
      if (expectOpen) fail(new Error("Realtime connection failed before the expected response"));
      else finish({ opened: false, snapshot: false });
    });
    socket.addEventListener("close", () => {
      if (!expectOpen) finish({ opened: false, snapshot: false });
      else if (!finished) fail(new Error("Realtime connection closed before the expected response"));
    });
  });
}
