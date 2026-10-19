import type {
  InspectionSqlRequest,
  InspectionSqlResult,
  InspectionSqlValue,
} from "@rally/contracts/engineering-inspection";
import { InspectionSqlRequestSchema } from "@rally/contracts/engineering-inspection";
import type { Env } from "../env";
import { MigratableDurableObject } from "./migratable-durable-object";

export function base64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32_768)));
  }
  return btoa(chunks.join(""));
}

function inspectionValue(value: SqlStorageValue): InspectionSqlValue {
  return value instanceof ArrayBuffer ? { type: "blob", base64: base64(value) } : value;
}

/**
 * Account-internal raw SQLite inspection for migrated Durable Objects.
 *
 * This is intentionally an unrestricted SQL surface: the public boundary is
 * the Access-protected engineering MCP Worker, and inspection must be able to
 * reproduce Cloudflare's dashboard database console, including repairs. No
 * Its intended caller is the private EngineeringInspectionBridge Service
 * Binding; no product HTTP route exposes this RPC.
 */
export abstract class InternallyInspectableDurableObject<TEnv extends Env = Env>
  extends MigratableDurableObject<TEnv> {
  async runInspectionSql(input: InspectionSqlRequest): Promise<InspectionSqlResult> {
    const request = InspectionSqlRequestSchema.parse(input);
    await this.migrationsReady();
    const cursor = this.ctx.storage.sql.exec<Record<string, SqlStorageValue>>(
      request.sql,
      ...request.bindings,
    );
    const rows = cursor.toArray().map((row) => Object.fromEntries(
      Object.entries(row).map(([column, value]) => [column, inspectionValue(value)]),
    ));
    return {
      columns: cursor.columnNames,
      rows,
      rowsRead: cursor.rowsRead,
      rowsWritten: cursor.rowsWritten,
    };
  }
}
