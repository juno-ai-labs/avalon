import type { CanvasSeed } from "../services/canvas-seed-service";
import { GETTING_STARTED_WITH_CANVASES } from "./getting-started-with-canvases";

/** Every seed the Worker carries, by key: what a `canvas_seed` job may name. */
export const CANVAS_SEEDS: Readonly<Record<string, CanvasSeed>> = {
  [GETTING_STARTED_WITH_CANVASES.key]: GETTING_STARTED_WITH_CANVASES,
};

/** The seeds a new Organization is given, in order. */
export const NEW_ORGANIZATION_CANVAS_SEEDS: readonly CanvasSeed[] = [GETTING_STARTED_WITH_CANVASES];
