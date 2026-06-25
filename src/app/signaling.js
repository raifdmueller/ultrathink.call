// Signaling Transport port (BB-4) + the Manual adapter (capability-URL + mailto).
//
// The port contract is transport-agnostic: produce a capability token for a local
// description, and consume one from untrusted text. Today there is one adapter —
// the manual links below; the R2 broker adapter (issue #22) is the second one and
// must not touch peer.js or codec.js.
import { encodePayload, decodePayload, extractToken } from "./codec.js";

const baseUrl = () => location.origin + location.pathname;

export async function buildCapabilityUrl(kind, room, sdp, exp) {
  const payload = { v: 1, room, kind, sdp };
  if (exp) payload.exp = exp;                                // optional expiry (epoch ms)
  const token = await encodePayload(payload);
  const fragment = kind === "offer" ? "invite" : "answer";  // payload kind vs URL fragment name
  return `${baseUrl()}#${fragment}=${token}`;
}

// True if an invite payload carries an expiry that has passed. `exp` rides inside
// the (unsigned) capability token, so it is advisory hygiene — auto-invalidating a
// stale or forwarded link — not an enforced TTL: a token holder can re-encode it.
// The token itself stays the bearer secret (BR-1); expiry only bounds replay.
export const isExpired = (payload) => typeof payload.exp === "number" && Date.now() > payload.exp;

export async function parseIncoming(text) {
  return decodePayload(extractToken(text));
}

export function mailtoLink(subject, intro, url) {
  const body = `${intro}\n\n${url}\n`;
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export function inviteTokenInHash() {
  const m = location.hash.match(/#invite=([A-Za-z0-9\-_]+)/);
  return m ? m[1] : null;
}
