import type { EngineeringInspectionRpcBinding } from "@rally/contracts/engineering-inspection";

import type { AccessEnvironment } from "./access";

export interface Env extends AccessEnvironment {
  GLOBAL_INSPECTION: EngineeringInspectionRpcBinding;
  EU_INSPECTION: EngineeringInspectionRpcBinding;
}
