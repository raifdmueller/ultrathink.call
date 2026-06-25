// SM-2 / D-9: the STUN set must be sovereign (non-US) with a fallback.
import { describe, it, expect } from "vitest";
import { ICE_CONFIG } from "../src/app/peer.js";

const SOVEREIGN_HOSTS = ["stun.nextcloud.com", "stun.sipgate.net", "stun.1und1.de"];
const US_MARKERS = ["google", "twilio", "cloudflare", "amazonaws", "stunprotocol.org"];

const urls = ICE_CONFIG.iceServers.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]));

describe("sovereign STUN set (D-9, SM-2)", () => {
  it("configures at least two endpoints (primary + fallback)", () => {
    expect(urls.length).toBeGreaterThanOrEqual(2);
  });

  it("uses only sovereign (non-US) hosts", () => {
    for (const url of urls) {
      const host = url.replace(/^stuns?:/, "").split(":")[0];
      expect(SOVEREIGN_HOSTS).toContain(host);
      for (const us of US_MARKERS) expect(url.toLowerCase()).not.toContain(us);
    }
  });
});
