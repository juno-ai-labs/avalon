import type { NormalizedActivity } from "@rally/contracts";

/** Configured Google files share their provider ID across delegated connections. */
export function isPortableGoogleActivityResource(activity: Pick<NormalizedActivity, "provider" | "resourceType" | "providerResourceId">): boolean {
  return activity.provider === "google" && Boolean(activity.providerResourceId)
    && ["google_sheet", "google_doc", "drive_file"].includes(activity.resourceType ?? "");
}
