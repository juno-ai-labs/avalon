import {
  SearchEngineeringOrganizationsResultSchema,
  type EngineeringInspectionRpcBinding,
  type EngineeringOrganization,
  type SearchEngineeringOrganizationsInput,
} from "@rally/contracts/engineering-inspection";
import { z } from "zod";

/** Rows per page when the caller sets no limit; docs/engineering-mcp.md says why. */
export const DEFAULT_ORGANIZATION_PAGE_SIZE = 200;

const OrderBySchema = z.enum(["createdAt", "name", "memberCount", "lastSeenAt"]);
type OrderBy = z.infer<typeof OrderBySchema>;

/** Page numbers rather than a cursor; docs/engineering-mcp.md says why. */
export const organizationPageInputSchema = {
  orderBy: OrderBySchema.optional().describe(
    "Sort key; createdAt by default. Organizations never seen sort last for lastSeenAt in either direction.",
  ),
  direction: z.enum(["asc", "desc"]).optional().describe(
    "asc by default for name, desc (newest or largest first) for every other key.",
  ),
  limit: z.number().int().positive().optional().describe(
    `Rows per page; ${DEFAULT_ORGANIZATION_PAGE_SIZE} by default.`,
  ),
  page: z.number().int().positive().optional().describe(
    "Page number, from 1 (the default). For the next page, repeat every other argument unchanged and pass nextPage.",
  ),
};

export type OrganizationPageRequest = z.infer<z.ZodObject<typeof organizationPageInputSchema>>;

export type OrganizationPage = {
  items: EngineeringOrganization[];
  page: number;
  pageCount: number;
  /** Matches across every page, not just this one. */
  total: number;
  /** The `page` to ask for next; null on the last page. */
  nextPage: number | null;
};

function compare(left: EngineeringOrganization, right: EngineeringOrganization, orderBy: OrderBy, sign: number): number {
  const a = left[orderBy];
  const b = right[orderBy];
  if ((a === null) !== (b === null)) return a === null ? 1 : -1;
  // createdAt and lastSeenAt are uniform UTC ISO strings, so plain comparison orders them.
  const order = orderBy === "name"
    ? left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
    : a! < b! ? -1 : a! > b! ? 1 : 0;
  return sign * order || left.workspaceId.localeCompare(right.workspaceId);
}

/**
 * Search every region, order the merged set, and return one page of it. The
 * regions filter; ordering and paging run here, once, over all of them.
 */
export async function organizationPage(
  bindings: EngineeringInspectionRpcBinding[],
  filter: SearchEngineeringOrganizationsInput,
  {
    orderBy = "createdAt",
    direction = orderBy === "name" ? "asc" : "desc",
    limit = DEFAULT_ORGANIZATION_PAGE_SIZE,
    page = 1,
  }: OrganizationPageRequest,
): Promise<OrganizationPage> {
  const results = await Promise.all(bindings.map((binding) => binding.searchOrganizations(filter)));
  const sign = direction === "asc" ? 1 : -1;
  const sorted = results.flatMap((result) => SearchEngineeringOrganizationsResultSchema.parse(result).items)
    .sort((left, right) => compare(left, right, orderBy, sign));
  const pageCount = Math.max(1, Math.ceil(sorted.length / limit));
  return {
    items: sorted.slice((page - 1) * limit, page * limit),
    page,
    pageCount,
    total: sorted.length,
    nextPage: page < pageCount ? page + 1 : null,
  };
}
