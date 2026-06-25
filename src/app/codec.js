// Token Codec (BB-5) — pure, DOM-free, runs in the browser and in Node (vitest).
// gzip + base64url encode/decode of the capability-URL signaling payload, with
// decode-time validation VR-1..6,8,9. Uses only web-standard globals.

export const MAX_TOKEN = 100000;        // VR-1: reject oversized tokens (anti-DoS)
export const MAX_DECOMPRESSED = 512000; // VR-8: cap gunzip output (anti gzip-bomb)
export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function gzip(str) {
  if (typeof CompressionStream === "undefined") return null;
  const cs = new CompressionStream("gzip");
  const w = cs.writable.getWriter(); w.write(new TextEncoder().encode(str)); w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

async function gunzip(bytes, maxOut) {
  const ds = new DecompressionStream("gzip");
  const w = ds.writable.getWriter(); w.write(bytes); w.close();
  const reader = ds.readable.getReader();
  const chunks = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxOut) throw new Error("Dekomprimierte Daten zu groß.");
    chunks.push(value);
  }
  const out = new Uint8Array(total); let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return new TextDecoder().decode(out);
}

function b64urlEnc(bytes) {
  let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDec(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(str), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function encodePayload(obj) {
  const json = JSON.stringify(obj);
  const raw = new TextEncoder().encode(json);
  const gz = await gzip(json);
  return gz && gz.length < raw.length ? "g" + b64urlEnc(gz) : "r" + b64urlEnc(raw);
}

// Decode AND validate: every field is attacker-influenceable (URL fragment / pasted text).
export async function decodePayload(token) {
  if (!token || token.length > MAX_TOKEN) throw new Error("Eingabe fehlt oder ist zu groß.");
  const tag = token[0], body = b64urlDec(token.slice(1));
  const json = tag === "g" ? await gunzip(body, MAX_DECOMPRESSED) : new TextDecoder().decode(body);
  const p = JSON.parse(json);
  if (p?.v !== 1 || (p.kind !== "offer" && p.kind !== "answer")) throw new Error("Unbekanntes Format.");
  if (typeof p.room !== "string" || !UUID_V4.test(p.room)) throw new Error("Ungültige Raum-ID.");
  if (!p.sdp || p.sdp.type !== p.kind || typeof p.sdp.sdp !== "string") throw new Error("Ungültiges SDP.");
  if (!/a=fingerprint:/i.test(p.sdp.sdp)) throw new Error("SDP ohne DTLS-Fingerprint abgelehnt.");
  return p;
}

// Accept a full link (#invite=/#answer=) or a bare token.
export function extractToken(text) {
  text = text.trim();
  const m = text.match(/#(?:invite|answer)=([A-Za-z0-9\-_]+)/);
  return m ? m[1] : text;
}
