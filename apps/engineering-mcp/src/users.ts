import {
  SearchEngineeringUsersResultSchema,
  type EngineeringInspectionRpcBinding,
  type EngineeringUser,
  type SearchEngineeringUsersInput,
} from "@rally/contracts/engineering-inspection";

import { orderAndPage, pageInputSchema, type Ordering, type Page, type PageRequest } from "./paging";

type UserKey = "createdAt" | "name" | "email" | "lastSeenAt" | "organizationCount";

const userOrdering: Ordering<EngineeringUser, UserKey> = {
  keys: ["createdAt", "name", "email", "lastSeenAt", "organizationCount"],
  defaultKey: "createdAt",
  textKeys: ["name", "email"],
  value: (user, key) => key === "organizationCount" ? user.organizations.length : user[key],
  // Users are regional rows: one person can have a row in each region.
  id: (user) => `${user.region}:${user.userId}`,
};

export const userPageInputSchema = pageInputSchema(userOrdering);

/**
 * Search every region, order the merged set, and return one page of it. The
 * regions filter; ordering and paging run here, once, over all of them.
 */
export async function userPage(
  bindings: EngineeringInspectionRpcBinding[],
  filter: SearchEngineeringUsersInput,
  request: PageRequest<UserKey>,
): Promise<Page<EngineeringUser>> {
  const results = await Promise.all(bindings.map((binding) => binding.searchUsers(filter)));
  return orderAndPage(
    results.flatMap((result) => SearchEngineeringUsersResultSchema.parse(result).items),
    userOrdering,
    request,
  );
}
