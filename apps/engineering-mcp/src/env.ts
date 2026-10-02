import type { EngineeringInspectionRpcBinding } from "@rally/contracts/engineering-inspection";

import type { FlagAdministrationRpc } from "../../ace/src/protocol";
import type { AccessEnvironment } from "./access";

export interface Env extends AccessEnvironment {
  GLOBAL_INSPECTION: EngineeringInspectionRpcBinding;
  [binding: `${string}_INSPECTION`]: EngineeringInspectionRpcBinding;
  /** Ace's `FlagAdministration` entrypoint: the one write path for managed flags. */
  FLAG_ADMINISTRATION: FlagAdministrationRpc;
}
