import { z } from "zod";

export const RESOURCE_RELATIONSHIP_TYPES = [
  "attachment",
  "message_attachment",
  "origin",
  "generated",
  "inbound_email",
  "context",
] as const;

export const ResourceRelationshipTypeSchema = z.enum(RESOURCE_RELATIONSHIP_TYPES);
export type ResourceRelationshipType = z.infer<typeof ResourceRelationshipTypeSchema>;

/**
 * Parse-only compatibility for resources serialized by the previous Worker
 * during a rolling deployment. Current storage and every write contract use
 * `ResourceRelationshipTypeSchema`; the desktop normalizes this retired value
 * to `attachment` immediately after parsing it.
 */
export const WireResourceRelationshipTypeSchema = z.union([
  ResourceRelationshipTypeSchema,
  z.literal("suggested_activity"),
]);
export type WireResourceRelationshipType = z.infer<typeof WireResourceRelationshipTypeSchema>;

export const RESOURCE_DIRECTIONS = ["source", "artifact"] as const;
export const ResourceDirectionSchema = z.enum(RESOURCE_DIRECTIONS);
export type ResourceDirection = z.infer<typeof ResourceDirectionSchema>;

export function resourceDirectionForRelationship(
  relationshipType: ResourceRelationshipType,
): ResourceDirection {
  return relationshipType === "generated" ? "artifact" : "source";
}
