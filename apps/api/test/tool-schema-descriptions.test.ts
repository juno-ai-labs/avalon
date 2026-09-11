import { describe, expect, it } from "vitest";

import { defaultedRequiredParameters, undescribedParameters } from "@rally/agent-harness";
import { everyAuthoredToolSchema, toolSurface } from "./helpers/authored-tool-schemas";

/**
 * What a model can tell about a parameter from the schema alone, walked over
 * every tool Rally authors.
 *
 * The failure this exists for was not an error. A run asked to list a
 * repository's open pull requests called `github_pull_requests_list` and got
 * back `[]`, twice, for a repository holding twenty-five of them, then reported
 * the repository as having none and went to the terminal for a credential to
 * ask `git` directly. Nothing in the fleet noticed, because nothing had gone
 * wrong: the connector reached GitHub, GitHub answered HTTP 200, and the answer
 * was empty because the call carried a `head` filter the model had invented.
 *
 * Two schema defects put it there, and both are asserted below because either
 * alone would have been survivable:
 *
 * - **The parameter said nothing.** `head` reached the model as
 *   `{ type: "string", minLength: 1, maxLength: 250 }`. GitHub's filter wants
 *   `owner:branch` and answers anything else with an empty list rather than an
 *   error, and none of that is inferable from a name and two bounds. All 112
 *   GitHub parameters were in that state.
 * - **The schema demanded the defaults.** `z.toJSONSchema` was called in its
 *   `io: "output"` default, which lists every `.default()` field as `required`,
 *   so the tool advertised `state`, `sort`, `direction`, `perPage`, and `page`
 *   as mandatory. A schema insisting on five values the executor would have
 *   chosen itself reads as an instruction to fill in the parameter block, which
 *   is how the two undescribed filters beside them came to be filled in too.
 *
 * The second is a mechanical defect with one right answer, so it is asserted at
 * zero. The first is prose somebody has to write, and it was 239 parameters
 * across eleven surfaces when this guard was written — so it is asserted per
 * surface, exactly. Ten of those surfaces have since been paid off, leaving
 * `multimodal`'s twelve. A ratchet rather than a floor: a surface at 0 can
 * never regress, a surface with debt can only pay it down, and a new tool has
 * to state which it is. Both are `docs/agent-tools.md` rules; this is where
 * they are held.
 *
 * The map is also what makes a *missing* surface visible. `multimodal` reached
 * it only after a review noticed the walk never built the plugin — it returns
 * `null` without the Azure inference pair — so its three served tools and their
 * twelve undescribed parameters passed both guards by not being looked at.
 * `EXPECTED_TOOLS` in the helper now carries a sentinel for it. Two run-state
 * tools stay outside the walk on purpose, and the helper's own comment names
 * them and says why, so "every authored tool" is a boundary rather than a
 * claim nobody checked.
 */
describe("tool schema parameter descriptions", () => {
  it("demands no parameter it already supplies a default for", () => {
    // Flat zero rather than per surface: this one is a call-site mistake with a
    // single correct fix, `z.toJSONSchema(schema, { io: "input" })`, and there
    // is no version of it worth carrying as debt.
    const demanded = everyAuthoredToolSchema().flatMap(({ name, schema }) =>
      defaultedRequiredParameters(schema).map((finding) => `${name}.${finding}`));

    expect(demanded).toEqual([]);
  });

  it("leaves no parameter for a model to guess at, on a surface that owes none", () => {
    // Named rather than counted, for every surface the map records at zero.
    // This was GitHub's assertion alone while eleven surfaces still carried
    // debt; a paid-off surface tolerates regressions exactly as narrowly as
    // GitHub does, and a count that moves from 0 to 1 is the least useful way
    // to say which parameter did it. The names are computed either way.
    const undescribed = everyAuthoredToolSchema()
      .filter(({ name }) => RECORDED_DEBT[toolSurface(name)] === 0)
      .flatMap(({ name, schema }) => undescribedParameters(schema).map((finding) => `${name}.${finding}`));

    expect(undescribed).toEqual([]);
  });

  it("holds every surface at its recorded count, so the debt can only shrink", () => {
    const walked = everyAuthoredToolSchema();
    const counts: Record<string, number> = {};
    for (const { name, schema } of walked) {
      const surface = toolSurface(name);
      counts[surface] = (counts[surface] ?? 0) + undescribedParameters(schema).length;
    }

    expect(counts).toEqual(RECORDED_DEBT);
  });
});

/**
 * Every surface Rally serves, with what it still owes.
 *
 * Lower a number when you describe a parameter; a new surface has to appear
 * here deliberately. A surface at zero is also what the named assertion above
 * reads, so zeroing one buys a failure that says which parameter regressed.
 * Terminal, X, and the time tool describe everything already, and are the shape
 * the rest were brought to.
 */
const RECORDED_DEBT: Record<string, number> = {
  elicitation: 0,
  github: 0,
  google: 0,
  granola: 0,
  linear: 0,
  memory: 0,
  multimodal: 12,
  notion: 0,
  rally: 0,
  slack: 0,
  table: 0,
  terminal: 0,
  time: 0,
  web: 0,
  workstream: 0,
  x: 0,
};
