import { WorkerEntrypoint } from "cloudflare:workers";

import type { Env } from "./env";
import {
  applyRegionalRoutingCommand,
  type PostgresRegionalRoutingBridgeBinding,
  type RegionalRoutingCommandInput,
} from "./postgres/routing-control";

/** Account-internal endpoint; no routing command is exposed over public HTTP. */
export class PostgresRegionalRoutingBridge extends WorkerEntrypoint<Env>
  implements PostgresRegionalRoutingBridgeBinding {
  applyRoutingCommand(input: RegionalRoutingCommandInput) {
    return applyRegionalRoutingCommand(this.env, input);
  }
}
