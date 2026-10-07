import { describe, expect, it } from "vitest";
import { uuidToBase58 } from "@rally/contracts/uuid-base58";

import { linkTitleTarget } from "../src/routes/links";

const WORKSPACE = "00000000-0000-7000-8000-0000000000a1";
const SPACE = "00000000-0000-7000-8000-0000000000a2";
const CHANNEL = "00000000-0000-7000-8000-0000000000a3";
const BREAKOUT = "00000000-0000-7000-8000-0000000000a4";
const base = `/app/global/${uuidToBase58(WORKSPACE)}`;

describe("linkTitleTarget", () => {
  it("reads which resource each canonical link path names", () => {
    expect(linkTitleTarget(`${base}/s/${uuidToBase58(SPACE)}/c/${uuidToBase58(CHANNEL)}`)).toEqual({
      region: "global", request: { workspaceId: WORKSPACE, target: { kind: "channel", workstreamId: CHANNEL } },
    });
    expect(linkTitleTarget(`${base}/s/${uuidToBase58(SPACE)}/c/${uuidToBase58(CHANNEL)}/b/${uuidToBase58(BREAKOUT)}`)).toEqual({
      region: "global",
      request: { workspaceId: WORKSPACE, target: { kind: "breakout", workstreamId: CHANNEL, substreamId: BREAKOUT } },
    });
    expect(linkTitleTarget(`${base}/s/${uuidToBase58(SPACE)}/`)).toEqual({
      region: "global", request: { workspaceId: WORKSPACE, target: { kind: "space", spaceId: SPACE } },
    });
    expect(linkTitleTarget(`${base}/sk/${uuidToBase58(CHANNEL)}/`)).toEqual({
      region: "global", request: { workspaceId: WORKSPACE, target: { kind: "sidekick", sidekickId: CHANNEL } },
    });
  });

  it("names nothing for a link without an Organization or a path that is not a link", () => {
    expect(linkTitleTarget(`/app/workstreams/${CHANNEL}`)).toBeNull();
    expect(linkTitleTarget("/help/")).toBeNull();
  });
});
