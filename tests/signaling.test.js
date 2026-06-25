// Invite expiry (#29) + native-share adapter (#42). Both are pure / navigator is
// touched only inside functions, so importing the module in Node is fine.
import { describe, it, expect, afterEach } from "vitest";
import { isExpired, shareData, canNativeShare } from "../src/app/signaling.js";

describe("invite expiry (#29)", () => {
  it("is not expired without an exp field", () => expect(isExpired({})).toBe(false));
  it("is not expired when exp is in the future", () => expect(isExpired({ exp: Date.now() + 10000 })).toBe(false));
  it("is expired when exp is in the past", () => expect(isExpired({ exp: Date.now() - 10000 })).toBe(true));
  it("ignores a non-numeric exp", () => expect(isExpired({ exp: "soon" })).toBe(false));
});

describe("native share adapter (#42)", () => {
  afterEach(() => { delete globalThis.navigator; });

  it("shareData carries the link in the canonical url field, intro as text", () => {
    expect(shareData("Einladung", "Tritt bei:", "https://x/#invite=t")).toEqual({
      title: "Einladung", text: "Tritt bei:", url: "https://x/#invite=t",
    });
  });

  it("canNativeShare is true when navigator.share is a function", () => {
    globalThis.navigator = { share: () => {} };
    expect(canNativeShare()).toBe(true);
  });

  it("canNativeShare is false when navigator has no share (fail-closed -> mailto)", () => {
    globalThis.navigator = {};
    expect(canNativeShare()).toBe(false);
  });

  it("canNativeShare is false when navigator is absent (Node / old browser)", () => {
    expect(canNativeShare()).toBe(false);
  });
});
