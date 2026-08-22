import { describe, expect, it } from "vitest";

import {
  TOOL_RECEIPT_OPERATIONS,
  isToolReceiptOperation,
  toolReceiptOperationAffectsDirectory,
} from "../src/durable-objects/workstream-tool-receipt-protocol";
import { WorkstreamToolReceiptStorage } from "../src/durable-objects/workstream-tool-receipt-storage";

/**
 * The dispatch list has to cover the storage class exactly.
 *
 * `Exhaustive<…>` makes a missing name a compile error, which is the fast
 * feedback. This is the same claim checked at run time, by reflection, because
 * the type is only as good as its own declaration: widening it back to a plain
 * `readonly ToolReceiptOperation[]` would restore the one-way `satisfies` gap
 * silently, and the failure that produces is a caller finding `undefined` where
 * a method should be.
 */
function publicStorageMethods(): string[] {
  return Object.getOwnPropertyNames(WorkstreamToolReceiptStorage.prototype)
    .filter((name) => name !== "constructor")
    // `sql` is a private accessor, not a dispatchable operation.
    .filter((name) => typeof Object.getOwnPropertyDescriptor(
      WorkstreamToolReceiptStorage.prototype,
      name,
    )?.value === "function")
    .sort();
}

describe("the tool-receipt operation contract", () => {
  it("dispatches every method the storage class exposes", () => {
    expect([...TOOL_RECEIPT_OPERATIONS].sort()).toEqual(publicStorageMethods());
  });

  it("names only methods that exist", () => {
    for (const operation of TOOL_RECEIPT_OPERATIONS) {
      const prototype = WorkstreamToolReceiptStorage.prototype as unknown as Record<string, unknown>;
      expect(typeof prototype[operation]).toBe("function");
    }
  });

  it("refuses a name that is not on the contract", () => {
    expect(isToolReceiptOperation("admit")).toBe(true);
    expect(isToolReceiptOperation("dropEverything")).toBe(false);
    // Prototype members are not operations: the guard reads a fixed set, not
    // the object, so `constructor` and friends cannot be dispatched.
    expect(isToolReceiptOperation("constructor")).toBe(false);
    expect(isToolReceiptOperation("toString")).toBe(false);
  });

  it("publishes no directory effect, for every operation", () => {
    // Asserted rather than assumed. The Terminal port shipped a regression by
    // inferring publication from a table-name regex; here the claim is that
    // receipts move no deadline the workspace alarm reads, and it is checked
    // per operation so an added one cannot inherit the answer by accident.
    for (const operation of TOOL_RECEIPT_OPERATIONS) {
      expect(toolReceiptOperationAffectsDirectory(operation)).toBe(false);
    }
  });
});
