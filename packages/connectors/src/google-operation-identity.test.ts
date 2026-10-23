import { describe, expect, it } from "vitest";
import { isPortableGoogleActivityResource } from "./google-operation-identity";

describe("configured Google source portability", () => {
  it.each(["google_sheet", "google_doc", "drive_file"])("recognizes globally addressed %s sources", (resourceType) => {
    expect(isPortableGoogleActivityResource({ provider: "google", resourceType, providerResourceId: "file-1" })).toBe(true);
  });
  it.each([
    { provider: "google", resourceType: "gmail_thread", providerResourceId: "thread-1" },
    { provider: "google", resourceType: "calendar_event", providerResourceId: "event-1" },
    { provider: "webhook", resourceType: "google_sheet", providerResourceId: "file-1" },
    { provider: "google", resourceType: "google_sheet", providerResourceId: null },
  ])("keeps non-portable or missing references on their configured connection: %s", (activity) => {
    expect(isPortableGoogleActivityResource(activity)).toBe(false);
  });
});
