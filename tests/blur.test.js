// Video-processing port / native-blur adapter (#25, BB-9). Pure detection logic
// and the fail-closed contract, exercised with faked MediaStreamTracks (no DOM).
// Traces: SM-4, QS-5, EARS-18, arc42 8.5.
import { describe, it, expect, vi } from "vitest";
import { supportsBlur, NativeBlurProcessor } from "../src/app/blur.js";

// `settings` is what getSettings() reports back after applyConstraints — the
// read-back the adapter uses to confirm blur actually engaged.
const trackWith = (caps, applyImpl, settings = { backgroundBlur: true }) => ({
  getCapabilities: () => caps,
  applyConstraints: applyImpl || (async () => {}),
  getSettings: () => settings,
});

describe("supportsBlur (#25)", () => {
  it("is true when the capability advertises backgroundBlur:true", () => {
    expect(supportsBlur(trackWith({ backgroundBlur: [false, true] }))).toBe(true);
  });
  it("is false when the capability is absent", () => {
    expect(supportsBlur(trackWith({}))).toBe(false);
  });
  it("is false when only false is offered", () => {
    expect(supportsBlur(trackWith({ backgroundBlur: [false] }))).toBe(false);
  });
  it("is false for a track without getCapabilities (old browser)", () => {
    expect(supportsBlur({})).toBe(false);
    expect(supportsBlur(null)).toBe(false);
  });
});

describe("NativeBlurProcessor (#25)", () => {
  it("applies the platform constraint when supported", async () => {
    const apply = vi.fn(async () => {});
    const p = new NativeBlurProcessor(trackWith({ backgroundBlur: [true] }, apply));
    await expect(p.setEnabled(true)).resolves.toBe(true);
    expect(apply).toHaveBeenCalledWith({ advanced: [{ backgroundBlur: true }] });
  });

  it("fails closed when the platform cannot blur (no silent unblurred frame)", async () => {
    const apply = vi.fn(async () => {});
    const p = new NativeBlurProcessor(trackWith({}, apply)); // unsupported
    await expect(p.setEnabled(true)).rejects.toThrow(/nicht unterstützt/);
    expect(apply).not.toHaveBeenCalled();
  });

  it("propagates an applyConstraints rejection so the caller can revert", async () => {
    const apply = vi.fn(async () => { throw new Error("OverconstrainedError"); });
    const p = new NativeBlurProcessor(trackWith({ backgroundBlur: [true] }, apply));
    await expect(p.setEnabled(true)).rejects.toThrow();
  });

  it("fails closed when applyConstraints resolves but blur did not engage (best-effort advanced constraint)", async () => {
    // The platform advertised the capability and applyConstraints resolved, but
    // getSettings shows blur is still off — must NOT claim blur is on.
    const p = new NativeBlurProcessor(trackWith({ backgroundBlur: [true] }, async () => {}, { backgroundBlur: false }));
    await expect(p.setEnabled(true)).rejects.toThrow(/nicht bestätigt/);
  });

  it("turning blur OFF needs no read-back confirmation (off is the safe state)", async () => {
    const p = new NativeBlurProcessor(trackWith({ backgroundBlur: [true] }, async () => {}, { backgroundBlur: false }));
    await expect(p.setEnabled(false)).resolves.toBe(false);
  });
});
