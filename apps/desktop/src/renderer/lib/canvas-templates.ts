import templates from 'virtual:rally-canvas-templates';

/** The Marketplace, in the order `canvas-template-catalog.ts` lists its files. */
export const CANVAS_TEMPLATES = templates;

export type CanvasTemplate = (typeof CANVAS_TEMPLATES)[number];
