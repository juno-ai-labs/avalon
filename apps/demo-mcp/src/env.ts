import type { DemoAdministrationRpc } from "@rally/contracts/demo-administration";

import type { AccessEnvironment } from "./access";

export interface Env extends AccessEnvironment {
  /** The Global API's `DemoAdministration` entrypoint: the one door into demo preparation. */
  DEMO_ADMINISTRATION: DemoAdministrationRpc;
}
