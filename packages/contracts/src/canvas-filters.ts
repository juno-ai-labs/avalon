import { z } from "zod";
import { deferredZodSchema } from "./deferred-zod-schema";

/**
 * The Canvases dashboard's filters, on every client: desktop and web filter
 * their rows directly, and the mobile shell filters the facts Home's snapshot
 * carries for each Canvas (`docs/mobile-canvas-client.md`). One definition so a
 * filter means the same thing on each.
 */
export const CANVAS_FILTERS = [
  ["all", "All"],
  ["reactive", "Reactive"],
  ["data", "Data backed"],
  ["mine", "Made by me"],
  ["shared", "Shared with me"],
] as const;

export type CanvasFilter = (typeof CANVAS_FILTERS)[number][0];

/** What the filters read about one Canvas, for one viewer. */
export const CanvasFilterFactsSchema = deferredZodSchema(() => z.object({
  reactive: z.boolean(),
  dataBacked: z.boolean(),
  mine: z.boolean(),
  sharedWithMe: z.boolean(),
}));
export type CanvasFilterFacts = z.infer<typeof CanvasFilterFactsSchema>;

/**
 * A Canvas shared with the viewer from another of their Organizations. Its
 * Reactive and Data facts stay in its Organization, and it is not theirs, so
 * only All and Shared with me keep it.
 */
export const ELSEWHERE_CANVAS_FACTS: CanvasFilterFacts = { reactive: false, dataBacked: false, mine: false, sharedWithMe: true };

/** What the filters read from a Canvas's sidebar row (`CanvasSidebarRow`). */
export type FilterableCanvas = {
  sidekicks?: readonly { status: string; triggerKinds?: readonly string[] | undefined }[] | undefined;
  hasStoredData?: boolean | undefined;
  createdByUserId: string;
  sharedWithMe: boolean;
};

/** An active Sidekick that wakes on its own (a schedule or an outside event) keeps the Canvas current. */
export function isReactiveCanvas(row: Pick<FilterableCanvas, "sidekicks">): boolean {
  return row.sidekicks?.some((sidekick) => sidekick.status === "active"
    && sidekick.triggerKinds?.some((kind) => kind === "schedule" || kind === "external_event")) ?? false;
}

export function canvasFilterFacts(row: FilterableCanvas, currentUserId: string | undefined): CanvasFilterFacts {
  return {
    reactive: isReactiveCanvas(row),
    dataBacked: row.hasStoredData === true,
    mine: currentUserId !== undefined && row.createdByUserId === currentUserId,
    sharedWithMe: row.sharedWithMe,
  };
}

export function matchesCanvasFilter(facts: CanvasFilterFacts, filter: CanvasFilter): boolean {
  switch (filter) {
    case "all": return true;
    case "reactive": return facts.reactive;
    case "data": return facts.dataBacked;
    case "mine": return facts.mine;
    case "shared": return facts.sharedWithMe;
  }
}
