import {
  SearchEngineeringOrganizationsResultSchema,
  type EngineeringInspectionRpcBinding,
  type EngineeringOrganization,
  type SearchEngineeringOrganizationsInput,
} from "@rally/contracts/engineering-inspection";

import { orderAndPage, pageInputSchema, type Ordering, type Page, type PageRequest } from "./paging";

type OrganizationKey = "createdAt" | "name" | "memberCount" | "lastSeenAt";

const organizationOrdering: Ordering<EngineeringOrganization, OrganizationKey> = {
  keys: ["createdAt", "name", "memberCount", "lastSeenAt"],
  defaultKey: "createdAt",
  textKeys: ["name"],
  value: (organization, key) => organization[key],
  id: (organization) => organization.workspaceId,
};

export const organizationPageInputSchema = pageInputSchema(organizationOrdering);

/**
 * Search every region, order the merged set, and return one page of it. The
 * regions filter; ordering and paging run here, once, over all of them.
 */
export async function organizationPage(
  bindings: EngineeringInspectionRpcBinding[],
  filter: SearchEngineeringOrganizationsInput,
  request: PageRequest<OrganizationKey>,
): Promise<Page<EngineeringOrganization>> {
  const results = await Promise.all(bindings.map((binding) => binding.searchOrganizations(filter)));
  return orderAndPage(
    results.flatMap((result) => SearchEngineeringOrganizationsResultSchema.parse(result).items),
    organizationOrdering,
    request,
  );
}
