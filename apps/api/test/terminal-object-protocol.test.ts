import { describe, expect, it } from "vitest";

import {
  TERMINAL_OPERATIONS,
  isTerminalOperation,
} from "../src/durable-objects/workstream-terminal-protocol";
import { WorkstreamTerminalStorage } from "../src/durable-objects/workstream-terminal-storage";

/**
 * The dispatch list has to cover the storage class exactly.
 *
 * `Exhaustive<…>` makes a missing name a compile error, which is the fast
 * feedback. This is the same claim checked at run time, by reflection, because
 * the type is only as good as its own declaration: someone widening it back to
 * a plain `readonly TerminalOperation[]` would restore the one-way `satisfies`
 * gap silently, and the failure it produces is a caller finding `undefined`
 * where a method should be.
 */
function publicStorageMethods(): string[] {
  return Object.getOwnPropertyNames(WorkstreamTerminalStorage.prototype)
    .filter((name) => name !== "constructor")
    // `sql` is a private accessor, not a dispatchable operation.
    .filter((name) => {
      const descriptor = Object.getOwnPropertyDescriptor(
        WorkstreamTerminalStorage.prototype,
        name,
      );
      return typeof descriptor?.value === "function";
    })
    .sort();
}

describe("the Terminal operation contract", () => {
  it("dispatches every method the storage class exposes", () => {
    expect([...TERMINAL_OPERATIONS].sort()).toEqual(publicStorageMethods());
  });

  it("refuses a name that is not on the contract", () => {
    expect(isTerminalOperation("sandbox")).toBe(true);
    expect(isTerminalOperation("dropEverything")).toBe(false);
    // Prototype members are not operations: the guard reads a fixed set, not
    // the object, so `constructor` and friends cannot be dispatched.
    expect(isTerminalOperation("constructor")).toBe(false);
    expect(isTerminalOperation("toString")).toBe(false);
  });
});
