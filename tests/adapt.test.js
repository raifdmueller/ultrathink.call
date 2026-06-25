// Adaptive controller tier-stepping logic (#27, R4). Pure logic, Node-testable —
// time is injected, so no fake timers. Traces: SM-3, QS-3, EARS-16.
import { describe, it, expect } from "vitest";
import { AdaptController, TIERS } from "../src/app/adapt.js";

const opts = { downAfterMs: 6000, upAfterMs: 30000 };

describe("AdaptController (#27)", () => {
  it("starts at full quality (tier 0)", () => {
    const c = new AdaptController(opts);
    expect(c.index).toBe(0);
    expect(c.tier).toEqual(TIERS[0]);
  });

  it("does not step down for pressure shorter than the window", () => {
    const c = new AdaptController(opts);
    expect(c.sample(true, 0)).toBeNull();
    expect(c.sample(true, 5999)).toBeNull(); // still under 6000 ms
    expect(c.index).toBe(0);
  });

  it("steps down one tier after sustained pressure", () => {
    const c = new AdaptController(opts);
    c.sample(true, 0);
    const tier = c.sample(true, 6000);
    expect(c.index).toBe(1);
    expect(tier).toEqual(TIERS[1]);
  });

  it("eases down one tier per window, never lurching", () => {
    const c = new AdaptController(opts);
    c.sample(true, 0);
    c.sample(true, 6000);   // -> tier 1
    expect(c.index).toBe(1);
    c.sample(true, 11999);  // only 5999 ms since the step, not yet
    expect(c.index).toBe(1);
    c.sample(true, 12000);  // -> tier 2
    expect(c.index).toBe(2);
  });

  it("stops at the floor tier and never below 10 fps (SM-3)", () => {
    const c = new AdaptController(opts);
    let t = 0;
    for (let i = 0; i < 10; i++) { c.sample(true, t); t += 6000; c.sample(true, t); }
    expect(c.atFloor).toBe(true);
    expect(c.index).toBe(TIERS.length - 1);
    expect(c.tier.maxFramerate).toBe(10);
    expect(c.sample(true, t + 6000)).toBeNull(); // cannot drop past the floor
  });

  it("recovers one tier after sustained calm", () => {
    const c = new AdaptController(opts);
    c.sample(true, 0); c.sample(true, 6000); // at tier 1
    c.sample(false, 7000);                   // calm streak begins
    expect(c.sample(false, 36999)).toBeNull(); // under 30000 ms of calm
    const tier = c.sample(false, 37000);       // 30000 ms calm -> step up
    expect(c.index).toBe(0);
    expect(tier).toEqual(TIERS[0]);
  });

  it("resets the streak when pressure flips, so a blip does not step down", () => {
    const c = new AdaptController(opts);
    c.sample(true, 0);
    c.sample(false, 3000);  // pressure cleared before the down-window elapsed
    c.sample(true, 4000);   // new pressure streak starts here
    expect(c.sample(true, 9000)).toBeNull(); // only 5000 ms of the new streak
    expect(c.index).toBe(0);
  });
});
