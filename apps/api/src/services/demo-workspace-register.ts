import { z } from "zod";

/**
 * The record of which workspaces this feature published, read from the
 * operation that made each one.
 *
 * There is no register table of its own: the operation row is the register. A
 * workspace enters it when the creating phase allocates its id onto the row,
 * is published when `ready_at` is set, and is closed when `retired_at` is set.
 * Two things read it. Discovery withholds a candidate — a row with no
 * `ready_at` — from its members until preparation finishes, so nobody opens a
 * half-seeded sidebar. And the Demos page lists every operation, of which any
 * number may be live at once. It is not an authorization input for
 * retirement; that gate was considered and dropped, and retirement is an
 * operator action on any workspace, behind Ace's Access policy and a
 * confirmation.
 */

export const DemoWorkspaceRowSchema = z.strictObject({
  workspaceId: z.string().min(1),
  operationId: z.string().min(1),
  companyName: z.string().min(1),
  presenterUserId: z.string().min(1),
  packVersion: z.string().min(1),
  createdAt: z.string().min(1),
  readyAt: z.string().nullable(),
  retiredAt: z.string().nullable(),
});
export type DemoWorkspaceRow = z.infer<typeof DemoWorkspaceRowSchema>;

interface DemoWorkspaceRecord {
  workspace_id: string;
  operation_id: string;
  company_name: string;
  presenter_user_id: string;
  pack_version: string;
  created_at: string;
  ready_at: string | null;
  retired_at: string | null;
}

const DEMO_WORKSPACE_SELECT = `
  SELECT workspace_id, operation_id, company_name, presenter_user_id, pack_version,
         created_at, ready_at, retired_at
    FROM demo_operations`;

function toRow(record: DemoWorkspaceRecord): DemoWorkspaceRow {
  return DemoWorkspaceRowSchema.parse({
    workspaceId: record.workspace_id,
    operationId: record.operation_id,
    companyName: record.company_name,
    presenterUserId: record.presenter_user_id,
    packVersion: record.pack_version,
    createdAt: record.created_at,
    readyAt: record.ready_at,
    retiredAt: record.retired_at,
  });
}

/** The workspace an operation allocated, or null before it allocated one. */
export async function demoWorkspaceByOperation(
  db: D1Database,
  operationId: string,
): Promise<DemoWorkspaceRow | null> {
  const record = await db.prepare(
    `${DEMO_WORKSPACE_SELECT} WHERE operation_id = ? AND workspace_id IS NOT NULL`,
  ).bind(operationId).first<DemoWorkspaceRecord>();
  return record ? toRow(record) : null;
}

/**
 * Publish a candidate.
 *
 * The gap between allocation and this is the preparation, and the whole point
 * of the candidate state is that a workspace exists and is being filled
 * without being offered to anybody. `ready_at` is what ends that, and it is
 * written once: a resumed pass does not move the instant.
 */
export async function markDemoWorkspaceReady(
  db: D1Database,
  operationId: string,
  now: string,
): Promise<DemoWorkspaceRow | null> {
  await db.prepare(
    "UPDATE demo_operations SET ready_at = ?, updated_at = ? WHERE operation_id = ? AND ready_at IS NULL",
  ).bind(now, now, operationId).run();
  return demoWorkspaceByOperation(db, operationId);
}

/**
 * The regional shadow of the tombstone.
 *
 * Written only once the walk reported its whole graph closed, so the register
 * never says a demo is gone while an object under it is still open. It exists
 * so the Demos page can say a demo is gone without waking a retired object to
 * ask it. A no-op for a workspace this feature never made.
 */
export async function markDemoWorkspaceRetired(
  db: D1Database,
  workspaceId: string,
  now: string,
): Promise<void> {
  await db.prepare(
    "UPDATE demo_operations SET retired_at = ?, updated_at = ? WHERE workspace_id = ? AND retired_at IS NULL",
  ).bind(now, now, workspaceId).run();
}
