// Unit tests for the token codec and validation rules (story #19).
// Traces to spec VR-1..6,8,9 and BR-7. Runs in Node via vitest — codec.js is DOM-free.
import { describe, it, expect } from "vitest";
import { encodePayload, decodePayload, extractToken, MAX_TOKEN } from "../src/app/codec.js";

const ROOM = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const OFFER = { v: 1, kind: "offer", room: ROOM, sdp: { type: "offer", sdp: "v=0\r\na=fingerprint:sha-256 AA:BB\r\n" } };

describe("codec round-trip", () => {
  it("encodes then decodes back to the original payload", async () => {
    const token = await encodePayload(OFFER);
    expect(await decodePayload(token)).toEqual(OFFER);
  });

  it("produces a URL-safe token (no +/=)", async () => {
    const token = await encodePayload(OFFER);
    expect(token).toMatch(/^[gr][A-Za-z0-9\-_]+$/);
  });
});

describe("validation rejects malformed tokens", () => {
  it("VR-1: oversized token", async () => {
    await expect(decodePayload("r" + "A".repeat(MAX_TOKEN))).rejects.toThrow(/zu groß/);
  });

  it("VR-2: invalid base64/gzip body", async () => {
    await expect(decodePayload("g@@@@")).rejects.toThrow();
  });

  it("VR-8: decompresses beyond the output cap (gzip bomb)", async () => {
    const bomb = { ...OFFER, sdp: { type: "offer", sdp: "a=fingerprint:" + "x".repeat(600000) } };
    const token = await encodePayload(bomb);
    expect(token.length).toBeLessThan(MAX_TOKEN); // small on the wire …
    await expect(decodePayload(token)).rejects.toThrow(/Dekomprimierte/); // … huge on decode
  });

  it("VR-3: wrong version", async () => {
    await expect(decodePayload(await encodePayload({ ...OFFER, v: 2 }))).rejects.toThrow(/Unbekanntes Format/);
  });

  it("VR-4: kind not in {offer, answer}", async () => {
    const t = await encodePayload({ ...OFFER, kind: "evil", sdp: { type: "evil", sdp: "a=fingerprint:x" } });
    await expect(decodePayload(t)).rejects.toThrow(/Unbekanntes Format/);
  });

  it("VR-5: room is not a UUIDv4", async () => {
    await expect(decodePayload(await encodePayload({ ...OFFER, room: "not-a-uuid" }))).rejects.toThrow(/Raum-ID/);
  });

  it("VR-6: sdp.type does not match kind", async () => {
    const t = await encodePayload({ ...OFFER, sdp: { type: "answer", sdp: "a=fingerprint:x" } });
    await expect(decodePayload(t)).rejects.toThrow(/Ungültiges SDP/);
  });

  it("VR-9: SDP without a DTLS fingerprint", async () => {
    const t = await encodePayload({ ...OFFER, sdp: { type: "offer", sdp: "v=0\r\n" } });
    await expect(decodePayload(t)).rejects.toThrow(/Fingerprint/);
  });
});

describe("extractToken", () => {
  it("pulls the token out of a full invite URL", () => {
    expect(extractToken("https://example.org/app/#invite=gABC-_123")).toBe("gABC-_123");
  });
  it("pulls the token out of an answer URL", () => {
    expect(extractToken("https://example.org/app/#answer=rXYZ")).toBe("rXYZ");
  });
  it("returns a bare token unchanged (trimmed)", () => {
    expect(extractToken("  gABC123 ")).toBe("gABC123");
  });
});
