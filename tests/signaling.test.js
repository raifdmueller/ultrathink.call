// Invite expiry logic (#29). isExpired is pure; signaling.js touches `location`
// only inside other functions, so importing it in Node is fine.
import { describe, it, expect } from "vitest";
import { isExpired } from "../src/app/signaling.js";

describe("invite expiry (#29)", () => {
  it("is not expired without an exp field", () => expect(isExpired({})).toBe(false));
  it("is not expired when exp is in the future", () => expect(isExpired({ exp: Date.now() + 10000 })).toBe(false));
  it("is expired when exp is in the past", () => expect(isExpired({ exp: Date.now() - 10000 })).toBe(true));
  it("ignores a non-numeric exp", () => expect(isExpired({ exp: "soon" })).toBe(false));
});
