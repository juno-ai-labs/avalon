import type { EngineeringInspectionRpcBinding } from "@rally/contracts/engineering-inspection";

import type { AccessEnvironment } from "./access";

export interface Env extends AccessEnvironment {
  GLOBAL_INSPECTION: EngineeringInspectionRpcBinding;
  [binding: `${string}_INSPECTION`]: EngineeringInspectionRpcBinding;
  /** The account the Global lakehouse buckets and Workers Observability live in. */
  CLOUDFLARE_ACCOUNT_ID: string;
  /** Read token for the lakehouse buckets' Basin SQL; absent until provisioned. */
  BASIN_SQL_API_TOKEN?: string;
  /** Dedicated runtime token for Cloudflare Queue inspection and non-consuming peek. */
  QUEUES_API_TOKEN?: string;
  /** Read token for the account's Workers Logs and Traces; absent until provisioned. */
  WORKERS_OBSERVABILITY_API_TOKEN?: string;
}
