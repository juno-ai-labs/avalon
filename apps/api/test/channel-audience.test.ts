import { describe, expect, it } from "vitest";

import {
  audienceSourceApplicationPlan,
  audienceSourceRetractionPlan,
  effectiveChannelAudience,
  type NamedAudienceSource,
} from "../src/lib/channel-audience";

// UUIDv7-shaped because `WorkstreamReaderAudienceSchema` refines on the
// version nibble, exactly as production ids do.
const alice = "00000000-0000-7000-8000-0000000000a1";
const bob = "00000000-0000-7000-8000-0000000000b2";
const carol = "00000000-0000-7000-8000-0000000000c3";

function source(sourceId: string, scope: "personal" | "workspace", participantUserIds: string[] = []): NamedAudienceSource {
  return { sourceId, scope, participantUserIds };
}

describe("the effective audience of a Channel", () => {
  it("given a personal direct source and no others, when it is derived, then only its participants read", () => {
    expect(effectiveChannelAudience({
      direct: { scope: "personal", participantUserIds: [alice] },
      sources: [],
    })).toEqual({ scope: "personal", userIds: [alice] });
  });

  it("given one Organization-wide source, when it is derived, then the whole audience is Organization-wide", () => {
    expect(effectiveChannelAudience({
      direct: { scope: "personal", participantUserIds: [alice] },
      sources: [source("space-a", "personal", [bob]), source("space-b", "workspace")],
    })).toEqual({ scope: "workspace" });
  });

  it("given several personal sources, when it is derived, then the readers are their union without duplicates", () => {
    expect(effectiveChannelAudience({
      direct: { scope: "personal", participantUserIds: [alice, bob] },
      sources: [source("space-a", "personal", [bob, carol]), source("space-b", "personal", [carol])],
    })).toEqual({ scope: "personal", userIds: [alice, bob, carol] });
  });

  it("given an Organization-wide direct source, when a personal source is added, then it stays Organization-wide", () => {
    // A source widens and never narrows. Composing a personal Space with an
    // Organization-wide Channel the other way round would let adding a Channel
    // to a Space take access away from everyone who had it.
    expect(effectiveChannelAudience({
      direct: { scope: "workspace", participantUserIds: [alice] },
      sources: [source("space-a", "personal", [bob])],
    })).toEqual({ scope: "workspace" });
  });
});

describe("applying one audience source", () => {
  it("given a personal Channel and an Organization-wide source, when it is applied, then the scope widens and nobody is seated", () => {
    expect(audienceSourceApplicationPlan({
      current: { scope: "personal", userIds: [alice] },
      source: { scope: "workspace", participantUserIds: [bob] },
    })).toEqual({ widenScope: true, seatUserIds: [] });
  });

  it("given a personal Channel and a personal source, when it is applied, then only readers it adds are seated", () => {
    expect(audienceSourceApplicationPlan({
      current: { scope: "personal", userIds: [alice, bob] },
      source: { scope: "personal", participantUserIds: [bob, carol, carol] },
    })).toEqual({ widenScope: false, seatUserIds: [carol] });
  });

  it("given an Organization-wide Channel and a personal source, when it is applied, then nothing changes", () => {
    // Seating them would record this source as having supplied readers it did
    // not, and the retraction would then withdraw people who could always read.
    expect(audienceSourceApplicationPlan({
      current: { scope: "workspace" },
      source: { scope: "personal", participantUserIds: [carol] },
    })).toEqual({ widenScope: false, seatUserIds: [] });
  });
});

describe("retracting one audience source", () => {
  it("given a reader only the departing source supplied, when it is retracted, then that reader is removed", () => {
    expect(audienceSourceRetractionPlan({
      direct: { scope: "personal", participantUserIds: [alice] },
      remainingSources: [],
      currentReaders: { scope: "personal", userIds: [alice, bob] },
      suppliedByDeparting: [bob],
    })).toEqual({ narrowScope: false, seatUserIds: [], removeUserIds: [bob] });
  });

  it("given a reader another source still supplies, when the first is retracted, then that reader stays", () => {
    expect(audienceSourceRetractionPlan({
      direct: { scope: "personal", participantUserIds: [alice] },
      remainingSources: [source("space-b", "personal", [bob])],
      currentReaders: { scope: "personal", userIds: [alice, bob] },
      suppliedByDeparting: [bob],
    })).toEqual({ narrowScope: false, seatUserIds: [], removeUserIds: [] });
  });

  it("given a reader the direct source also supplies, when the source is retracted, then that reader stays", () => {
    expect(audienceSourceRetractionPlan({
      direct: { scope: "personal", participantUserIds: [alice, bob] },
      remainingSources: [],
      currentReaders: { scope: "personal", userIds: [alice, bob] },
      suppliedByDeparting: [bob],
    })).toEqual({ narrowScope: false, seatUserIds: [], removeUserIds: [] });
  });

  it("given nothing else is Organization-wide, when the wide source is retracted, then the scope narrows", () => {
    expect(audienceSourceRetractionPlan({
      direct: { scope: "personal", participantUserIds: [alice] },
      remainingSources: [],
      currentReaders: { scope: "workspace" },
      suppliedByDeparting: [],
    })).toEqual({ narrowScope: true, seatUserIds: [alice], removeUserIds: [] });
  });

  it("given a remaining source is still Organization-wide, when one is retracted, then nothing narrows", () => {
    expect(audienceSourceRetractionPlan({
      direct: { scope: "personal", participantUserIds: [alice] },
      remainingSources: [source("space-b", "workspace")],
      currentReaders: { scope: "workspace" },
      suppliedByDeparting: [bob],
    })).toEqual({ narrowScope: false, seatUserIds: [], removeUserIds: [] });
  });

  it("given a personal source applied while the Channel was Organization-wide, when the wide source leaves, then its readers are seated", () => {
    // The gap this closes: a personal source seats nobody while everyone can
    // already read, so the readers it supplies exist only as its participant
    // list. Narrowing without seating them would revoke access a source still
    // provides.
    expect(audienceSourceRetractionPlan({
      direct: { scope: "personal", participantUserIds: [alice] },
      remainingSources: [source("space-b", "personal", [bob, carol])],
      currentReaders: { scope: "workspace" },
      suppliedByDeparting: [],
    })).toEqual({ narrowScope: true, seatUserIds: [alice, bob, carol], removeUserIds: [] });
  });

  it("given a reader no source supplied, when one is retracted, then they are left alone", () => {
    // Only the provenance is a candidate for removal. `bob` is a reader the
    // direct source does not list either — somebody named in a message — and a
    // retraction that recomputed the audience instead of reading the
    // provenance would take him out of a Channel no Space ever put him in.
    expect(audienceSourceRetractionPlan({
      direct: { scope: "personal", participantUserIds: [alice] },
      remainingSources: [],
      currentReaders: { scope: "personal", userIds: [alice, bob, carol] },
      suppliedByDeparting: [carol],
    })).toEqual({ narrowScope: false, seatUserIds: [], removeUserIds: [carol] });
  });
});
