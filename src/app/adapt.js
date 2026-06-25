// Adaptive Media Controller (BB-8, #27, R4). Under sustained CPU or bandwidth
// pressure the local video encoding steps DOWN through fixed tiers, so the stream
// degrades instead of dropping — the alfaview failure must not recur (SM-3: stay
// connected, never below 10 fps). When the pressure clears for long enough it
// steps back UP. This is pure decision logic: no DOM, no WebRTC, and no clock of
// its own (the caller passes `now`), so it runs and tests in Node (IOSP: this is
// the Operation; peer.js/main.js are the Integration that reads stats and applies
// the verdict).

// Each tier scales the resolution down and caps the framerate. The last tier is
// the floor: maxFramerate 10 honours SM-3 ("stays connected at >=10 fps").
export const TIERS = [
  { scaleResolutionDownBy: 1, maxFramerate: 30 }, // full quality
  { scaleResolutionDownBy: 2, maxFramerate: 20 },
  { scaleResolutionDownBy: 4, maxFramerate: 15 },
  { scaleResolutionDownBy: 6, maxFramerate: 10 }, // floor — never below 10 fps (SM-3)
];

export const DOWN_AFTER_MS = 6000;  // sustained pressure before stepping down
export const UP_AFTER_MS = 30000;   // sustained calm before stepping back up (slower up than down)

export class AdaptController {
  constructor({ tiers = TIERS, downAfterMs = DOWN_AFTER_MS, upAfterMs = UP_AFTER_MS } = {}) {
    this.tiers = tiers;
    this.downAfterMs = downAfterMs;
    this.upAfterMs = upAfterMs;
    this.index = 0;            // current tier (0 = full quality)
    this._limited = null;      // the streak's state (limited vs. calm)
    this._since = null;        // when the current streak began
  }

  get tier() { return this.tiers[this.index]; }
  get atFloor() { return this.index === this.tiers.length - 1; }

  // Feed one observation (`limited` = the browser reported a CPU/bandwidth limit).
  // Returns the new tier when this sample crossed a threshold and changed it, else
  // null. Each step resets the streak, so dropping several tiers needs several
  // sustained windows — the controller eases down, it does not lurch.
  sample(limited, now) {
    if (this._limited !== limited) { this._limited = limited; this._since = now; }
    const held = now - this._since;

    if (limited && held >= this.downAfterMs && this.index < this.tiers.length - 1) {
      this.index++; this._since = now; return this.tier;
    }
    if (!limited && held >= this.upAfterMs && this.index > 0) {
      this.index--; this._since = now; return this.tier;
    }
    return null;
  }
}
