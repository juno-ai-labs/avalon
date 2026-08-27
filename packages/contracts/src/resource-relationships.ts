import { z } from "zod";

export const RESOURCE_RELATIONSHIP_TYPES = [
  "attachment",
  "message_attachment",
  "origin",
  "generated",
  "suggested_activity",
  "inbound_email",
  "context",
] as const;

export const ResourceRelationshipTypeSchema = z.enum(RESOURCE_RELATIONSHIP_TYPES);
export type ResourceRelationshipType = z.infer<typeof ResourceRelationshipTypeSchema>;

export const RESOURCE_DIRECTIONS = ["source", "artifact"] as const;
export const ResourceDirectionSchema = z.enum(RESOURCE_DIRECTIONS);
export type ResourceDirection = z.infer<typeof ResourceDirectionSchema>;

export function resourceDirectionForRelationship(
  relationshipType: ResourceRelationshipType,
): ResourceDirection {
  return relationshipType === "generated" ? "artifact" : "source";
}
