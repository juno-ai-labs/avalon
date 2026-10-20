import type { ExecutionPrincipal } from "@rally/contracts";
import { ConnectorError } from "@rally/connectors";
import type { Env } from "../env";
import { sha256Hex } from "../lib/crypto";
import { createConversationResourceLinks } from "../runtime/resource-port";
import { verifyAttachmentMimeType } from "./attachment-mime-verification";
import { withWorkspaceRuntimeDatabase } from "./workspace-runtime-database";
import { loadVisibleWorkstreamResourcesByIds } from "./workstream-resource-visibility";

/** Read an original through the same current conversation visibility as resource tools. */
export async function readConnectorResourceAttachment(
  env: Env,
  input: { workspaceId: string; workstreamId: string; substreamId: string; principal: ExecutionPrincipal },
  resourceId: string,
): Promise<{ fileName: string; mimeType: string; bytes: Uint8Array }> {
  env = withWorkspaceRuntimeDatabase(env, input.workspaceId);
  const [row] = await loadVisibleWorkstreamResourcesByIds(
    env.DB,
    createConversationResourceLinks(env, input.workspaceId, input.workstreamId, undefined, input.substreamId),
    { ...input, resourceIds: [resourceId] },
  );
  if (!row) throw new ConnectorError("unauthorized", "attachmentResourceIds: resource is not attached or visible to this run", { field: "attachmentResourceIds" });
  if (!row.content_ref) throw new ConnectorError("invalid_payload", "attachmentResourceIds: resource has no stored original file", { field: "attachmentResourceIds" });
  const object = await env.PAYLOADS.get(row.content_ref);
  if (!object) throw new ConnectorError("invalid_payload", "attachmentResourceIds: original file is unavailable; reattach the PDF", { field: "attachmentResourceIds" });
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (row.content_sha256 && await sha256Hex(bytes) !== row.content_sha256) {
    throw new ConnectorError("invalid_payload", "attachmentResourceIds: original file hash changed; list resources again", { field: "attachmentResourceIds" });
  }
  const mimeType = verifyAttachmentMimeType(bytes, row.title, row.mime_type);
  if (mimeType !== "application/pdf") throw new ConnectorError("invalid_payload", "attachmentResourceIds: resource must be a PDF file", { field: "attachmentResourceIds" });
  return { fileName: /\.pdf$/iu.test(row.title) ? row.title : `${row.title}.pdf`, mimeType, bytes };
}
