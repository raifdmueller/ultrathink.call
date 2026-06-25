// Video Processing port (S-5, ADR-5) + the browser-native background-blur adapter
// (BB-9, #25, ADR-9). The port is the third adapter slot beside signaling (BB-4)
// and ICE: a swappable seam for "transform the outgoing video before it is sent".
//
// This adapter delegates to the *platform's own* background blur — the
// MediaStreamTrack `backgroundBlur` capability (e.g. ChromeOS, Windows Studio
// Effects). No model is fetched, so the strict CSP (`script-src 'self'`) and the
// sovereignty goal (G-1) hold unchanged, and the supply-chain gate (#26, T-003)
// is not triggered. Where the platform cannot blur, the feature is simply
// unavailable: we never report a blur we cannot deliver (fail-closed, arc42 8.5).
//
// The port contract any video processor implements:
//   get supported(): boolean         — can this processor act on its track?
//   async setEnabled(on): boolean     — turn the effect on/off; rejects on failure
// A future vendored-model adapter (#26) implements the same shape and replaces
// this one without touching peer.js or main.js.

// Pure: does this track's capabilities advertise native background blur? Kept
// free of side effects so it is Node-testable with a faked track.
export function supportsBlur(track) {
  const caps = track?.getCapabilities?.();
  return Array.isArray(caps?.backgroundBlur) && caps.backgroundBlur.includes(true);
}

export class NativeBlurProcessor {
  constructor(track) { this.track = track; }

  get supported() { return supportsBlur(this.track); }

  // Request the platform blur on/off for this track. Resolves to the state that
  // is now actually in effect. Rejects if the platform cannot honour it, so the
  // caller fails closed (revert the toggle, warn) rather than streaming an
  // unblurred frame under a "blur on" label.
  async setEnabled(on) {
    if (!this.supported) throw new Error("Hintergrund-Blur wird von diesem Gerät/Browser nicht unterstützt.");
    await this.track.applyConstraints({ advanced: [{ backgroundBlur: on }] });
    return on;
  }
}
