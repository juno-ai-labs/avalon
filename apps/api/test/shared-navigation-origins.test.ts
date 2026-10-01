import { SharedNavigationDirectorySchema } from "@rally/contracts/scope-grants";
import { describe, expect, it } from "vitest";

import { withoutOriginFields } from "../src/services/shared-directory-service";

const directory = SharedNavigationDirectorySchema.parse({
  spaces: [{
    id: "01a0f9a7-590d-7ece-8565-694bec8c4379",
    name: "General",
    iconKey: "building-2",
    colorKey: "blue",
    scope: "workspace",
    systemRole: "general",
    workstreamIds: ["00000000-0000-7000-8000-000000000021"],
  }],
  workstreams: [{
    parentId: "00000000-0000-7000-8000-000000000021",
    title: "Investigate ENG-142",
    scope: "workspace",
    conversations: [
      { substreamId: "0", title: "Investigate ENG-142", scope: "workspace", archived: false },
      {
        substreamId: "01a0f996-5c91-7d22-a64c-fadc9899095e",
        title: "Check the Granola fallback timing",
        scope: "personal",
        archived: false,
        originTurnId: "turn-1",
      },
    ],
  }],
});

describe("withoutOriginFields", () => {
  it("leaves out the fields a strict shipped client would reject", () => {
    const shipped = withoutOriginFields(directory);
    expect(shipped.spaces[0]).not.toHaveProperty("systemRole");
    expect(shipped.workstreams[0]?.conversations[1]).not.toHaveProperty("originTurnId");
    expect(shipped.workstreams[0]?.conversations[1]?.title).toBe("Check the Granola fallback timing");
    expect(shipped.spaces[0]?.name).toBe("General");
  });
});
