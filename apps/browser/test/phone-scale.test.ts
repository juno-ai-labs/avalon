import { expect, it } from "vitest";
import { viewportContent } from "../src/phone-scale";

it("lays a phone out at its width over 1.2 in either orientation", () => {
  expect(viewportContent(390, 844, false)).toBe("width=325, initial-scale=1.2");
  expect(viewportContent(390, 844, true)).toBe("width=703, initial-scale=1.2");
  expect(viewportContent(393, 852, false)).toBe("width=327, initial-scale=1.2");
});

it("leaves a tablet at device width", () => {
  expect(viewportContent(744, 1133, false)).toBe("width=device-width, initial-scale=1.0");
});
