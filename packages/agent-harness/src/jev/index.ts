/**
 * The JEV building blocks: one request, one cascade, one question shape.
 *
 * `docs/jev-best-practices.md` owns how to design a JEV decision and lists
 * the decisions that want one.
 * These three files are what a new one is assembled from, and none of them
 * knows what any particular decision means.
 */
export * from "./cascade";
export * from "./client";
export * from "./questions";
