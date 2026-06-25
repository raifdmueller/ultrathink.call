// UI Shell (BB-1) + Media Manager (BB-2) glue. Drives a MeshSession: the host
// bootstraps each guest with a capability-URL, then the mesh forms automatically
// (ADR-8, no broker). One video tile per peer; device/screen changes apply to all.
import { MeshSession } from "./mesh.js";
import { buildCapabilityUrl, parseIncoming, mailtoLink, inviteTokenInHash, isExpired } from "./signaling.js";
import { AdaptController, TIERS, SAMPLE_INTERVAL_MS } from "./adapt.js";
import { NativeBlurProcessor, supportsBlur, UNSUPPORTED_MSG } from "./blur.js";

const INVITE_TTL_MS = 60 * 60 * 1000; // an invite link is valid for one hour (#29)
const EXPIRED_MSG = "Diese Einladung ist abgelaufen — bitte den Host um einen neuen Link.";

const $ = (id) => document.getElementById(id);
const status = (msg) => { $("status").textContent = msg; };
const show = (el, yes) => $(el).classList.toggle("hidden", !yes);

let mesh = null;
let localStream = null;
let camTrack = null;
let pendingOffer = null;       // guest: the host's offer awaiting join
let bootstrapPending = false;  // host: an invite is out, awaiting its answer
let sharing = false;           // a screen share is active
let blurOn = false;            // background blur requested by the user (#25)
let roomId = null;

const setRoom = () => { if (roomId) $("roomLine").textContent = "Raum: " + roomId; };
const getMedia = (c) => navigator.mediaDevices.getUserMedia(c);

// --- remote tiles, one per peer --------------------------------------------------
// Host-only kick/mute controls for one guest tile (#28). Kept separate from the
// tile factory so setTile stays pure composition (IOSP).
function moderationControls(peerId) {
  const ctl = document.createElement("div");
  ctl.className = "modctl";
  const kick = document.createElement("button");
  kick.textContent = "Entfernen";
  kick.addEventListener("click", () => mesh.kick(peerId));
  const mute = document.createElement("button");
  let muted = false;
  mute.textContent = "Stumm";
  mute.addEventListener("click", () => { muted = !muted; mesh.setMuted(peerId, muted); mute.textContent = muted ? "Laut" : "Stumm"; });
  ctl.append(kick, mute);
  return ctl;
}

function setTile(peerId, stream) {
  let tile = document.getElementById("tile-" + peerId);
  if (!tile) {
    tile = document.createElement("div");
    tile.className = "tile";
    tile.id = "tile-" + peerId;
    const v = document.createElement("video");
    v.autoplay = true; v.playsInline = true;
    const label = document.createElement("span");
    label.textContent = peerId === "host" ? "Host" : "Gast " + peerId.replace(/^p/, "");
    tile.append(v, label);
    if (mesh?.isHost && peerId !== "host") tile.append(moderationControls(peerId));
    $("videos").appendChild(tile);
  }
  tile.querySelector("video").srcObject = stream;
}
const removeTile = (peerId) => document.getElementById("tile-" + peerId)?.remove();
// We were kicked: drop every remote tile and reset, so the call ends cleanly.
function clearRemoteTiles() {
  document.querySelectorAll("#videos .tile[id]").forEach((t) => t.remove());
}

function ensureMesh(isHost) {
  if (!mesh) {
    adapt.reset(); // a fresh call starts at full quality, never a prior call's tier
    mesh = new MeshSession({
      stream: localStream,
      isHost,
      onPeerStream: (id, s) => { setTile(id, s); onPeerConnected(id); },
      onPeerLeave: (id) => { removeTile(id); if (!mesh || mesh.peers.size === 0) endAdapt(); },
      onStatus: (m) => status(m),
      onKicked: () => { clearRemoteTiles(); endAdapt(); mesh = null; status("Du wurdest vom Host aus dem Call entfernt."); },
    });
  }
  return mesh;
}

const eachPeer = (fn) => { if (mesh) for (const s of mesh.peers.values()) fn(s); };

// --- Adaptive media under load (#27, R4): degrade, do not drop -------------------
// CPU is shared across all our senders, so one controller drives the whole local
// encoding. Each tick we ask the browser whether any sender is CPU/bandwidth
// limited and let the controller decide; on a tier change we re-encode for every
// peer. The browser does the actual scaling — we only set the lever.
const adapt = new AdaptController();
let adaptTimer = null;

function startAdapt() { if (!adaptTimer) adaptTimer = setInterval(sampleAdapt, SAMPLE_INTERVAL_MS); }
// Stop sampling AND reset the controller — the call is over, so the next one must
// start from full quality with no leftover streak (else a late joiner inherits a
// dead tier and the timer ticks on forever).
function endAdapt() { clearInterval(adaptTimer); adaptTimer = null; adapt.reset(); }

async function sampleAdapt() {
  if (!mesh || mesh.peers.size === 0) return;
  let limited = false;
  for (const s of mesh.peers.values()) {
    try {
      const v = await s.videoLimitation();
      if (v && (v.reason === "cpu" || v.reason === "bandwidth")) { limited = true; break; }
    } catch { /* a peer mid-teardown — ignore this sample */ }
  }
  const tier = adapt.sample(limited, Date.now());
  if (tier) {
    for (const s of mesh.peers.values()) await s.applyVideoParams(tier).catch(() => {});
    status(`Videoqualität an die Auslastung angepasst (Stufe ${adapt.index + 1}/${TIERS.length}).`);
  }
}

// A peer that connects after we have already stepped down must start at the
// current tier, not full quality.
async function onPeerConnected(id) {
  startAdapt();
  if (adapt.index > 0) await mesh?.peers.get(id)?.applyVideoParams(adapt.tier).catch(() => {});
}

// --- Step 1: media + device list -------------------------------------------------
$("startCam").addEventListener("click", async () => {
  try {
    localStream = await getMedia({ video: true, audio: true });
    $("localVideo").srcObject = localStream;
    camTrack = localStream.getVideoTracks()[0] || null;
    $("startCam").disabled = true;
    // Screen sharing exists only in desktop browsers (not iOS/Android) — #34.
    $("shareScreen").disabled = !navigator.mediaDevices?.getDisplayMedia;
    if (!navigator.mediaDevices?.getDisplayMedia) $("shareScreen").title = "Auf diesem Browser/Gerät nicht verfügbar (z. B. mobil).";
    refreshBlurAvailability(); // #25: only offer blur where the platform can deliver it
    $("createInvite").disabled = false;
    if (pendingOffer) show("joinAnswer", true);
    await populateDevices();
    show("deviceRow", true);
    status(pendingOffer
      ? "Kamera läuft. Du wurdest eingeladen — jetzt „Beitreten & Antwort erzeugen“."
      : "Kamera läuft. Lade Teilnehmer über „Einladung erstellen“ ein (eine Einladung pro Person).");
  } catch (err) {
    status("Kamera/Mikro-Zugriff fehlgeschlagen: " + err.message);
  }
});

async function populateDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const fill = (sel, kind, current) => {
    const el = $(sel); el.replaceChildren();
    devices.filter((d) => d.kind === kind).forEach((d, i) => {
      const o = document.createElement("option");
      o.value = d.deviceId;
      o.textContent = d.label || `${kind} ${i + 1}`;
      if (d.deviceId === current) o.selected = true;
      el.appendChild(o);
    });
  };
  fill("camSelect", "videoinput", localStream.getVideoTracks()[0]?.getSettings().deviceId);
  fill("micSelect", "audioinput", localStream.getAudioTracks()[0]?.getSettings().deviceId);
}

// Switch only the changed device kind (#34): re-acquiring the unchanged device
// while its track is still live throws "device in use" on several platforms.
async function switchTrack(kind, deviceId) {
  try {
    const stream = await getMedia(kind === "video"
      ? { video: { deviceId: { exact: deviceId } } }
      : { audio: { deviceId: { exact: deviceId } } });
    const track = (kind === "video" ? stream.getVideoTracks() : stream.getAudioTracks())[0];
    for (const s of (mesh ? mesh.peers.values() : [])) {
      // While sharing, keep the screen on the peers' senders; the new camera
      // track is restored when the share ends.
      if (kind === "video") { if (!sharing) await s.replaceVideo(track); }
      else await s.replaceAudio(track);
    }
    const old = (kind === "video" ? localStream.getVideoTracks() : localStream.getAudioTracks())[0];
    if (old) { localStream.removeTrack(old); old.stop(); }
    localStream.addTrack(track);
    if (kind === "video") camTrack = track;
    mesh?.setStream(localStream);
    $("localVideo").srcObject = localStream;
    status("Gerät gewechselt.");
    if (kind === "video") {
      // The new camera track carries no blur; re-evaluate and re-apply, failing
      // closed (blur off + warn) if this device cannot blur (#25).
      refreshBlurAvailability();
      if (blurOn) {
        try { await applyBlur(true); }
        catch { revertBlur("Blur auf der neuen Kamera nicht verfügbar — aus."); }
      }
    }
  } catch (err) {
    status("Gerätewechsel fehlgeschlagen: " + err.message);
  }
}
$("camSelect").addEventListener("change", () => switchTrack("video", $("camSelect").value));
$("micSelect").addEventListener("change", () => switchTrack("audio", $("micSelect").value));

// --- Background blur (#25, BB-9): native, fail-closed -----------------------------
// We only ever offer blur the platform can actually deliver, and we never report
// "blur on" unless the platform confirmed it (fail-closed, arc42 8.5).
const BLUR_OFF_LABEL = "Hintergrund verwischen";
const BLUR_ON_LABEL = "Hintergrund anzeigen";

function refreshBlurAvailability() {
  // A screen share owns the outgoing video; blur applies to the camera, so the
  // toggle is meaningless mid-share.
  const ok = !sharing && !!camTrack && supportsBlur(camTrack);
  $("blurToggle").disabled = !ok;
  $("blurToggle").title = ok ? "" : UNSUPPORTED_MSG;
}

async function applyBlur(on) {
  // setEnabled confirms the effect engaged (read-back) or throws → we fail closed.
  blurOn = await new NativeBlurProcessor(camTrack).setEnabled(on);
  $("blurToggle").textContent = blurOn ? BLUR_ON_LABEL : BLUR_OFF_LABEL;
}

// Fail closed: forget the blur claim, reset the label, warn. One place so the
// toggle, the device switch, and the share-restore paths cannot drift.
function revertBlur(msg) {
  blurOn = false;
  $("blurToggle").textContent = BLUR_OFF_LABEL;
  status(msg);
}

$("blurToggle").addEventListener("click", async () => {
  try {
    await applyBlur(!blurOn);
    status(blurOn ? "Hintergrund wird verwischt." : "Hintergrund-Blur aus.");
  } catch (err) {
    revertBlur("Hintergrund-Blur fehlgeschlagen: " + err.message);
  }
});

// --- Host: create an invite for the next guest -----------------------------------
$("createInvite").addEventListener("click", async () => {
  if (bootstrapPending) { status("Es ist bereits eine Einladung offen — füge erst deren Antwort ein."); return; }
  if (mesh && !mesh.isHost) { status("Du bist als Gast beigetreten."); return; }
  $("createInvite").disabled = true;
  try {
    if (!roomId) { roomId = crypto.randomUUID(); setRoom(); }
    ensureMesh(true);
    const offer = await mesh.createBootstrapOffer();
    $("inviteUrl").value = await buildCapabilityUrl("offer", roomId, offer, Date.now() + INVITE_TTL_MS);
    $("copyInvite").disabled = false; $("mailInvite").disabled = false;
    bootstrapPending = true;
    status("Einladung erstellt. Schick den Link und füge unten die Antwort ein.");
  } catch (err) {
    $("createInvite").disabled = false;
    status("Einladung fehlgeschlagen: " + err.message);
  }
});

// --- Load an incoming invite (guest) or answer (host) ----------------------------
$("loadIncoming").addEventListener("click", async () => {
  const text = $("incomingIn").value;
  if (!text.trim()) return;
  try {
    const payload = await parseIncoming(text);
    if (payload.kind === "offer") {
      if (mesh && mesh.isHost) { status("Du bist Host — du kannst nicht deiner eigenen Einladung beitreten."); return; }
      if (isExpired(payload)) { status(EXPIRED_MSG); return; }
      pendingOffer = payload.sdp; roomId = payload.room; setRoom();
      show("joinAnswer", localStream != null);
      status(localStream
        ? "Einladung geladen. Jetzt „Beitreten & Antwort erzeugen“."
        : "Einladung geladen. Starte zuerst Kamera + Mikro, dann beitreten.");
    } else {
      if (!mesh || !mesh.isHost || !bootstrapPending) { status("Keine offene Einladung für diese Antwort."); return; }
      await mesh.acceptBootstrapAnswer(payload.sdp);
      bootstrapPending = false;
      $("createInvite").disabled = false;
      $("inviteUrl").value = ""; $("incomingIn").value = "";
      $("copyInvite").disabled = true; $("mailInvite").disabled = true;
      status("Teilnehmer verbunden. Lade weitere ein oder bleib einfach im Call — das Mesh verbindet sich selbst.");
    }
  } catch (err) {
    status("Konnte Eingabe nicht lesen: " + err.message);
  }
});

// --- Guest: join and produce an answer -------------------------------------------
$("joinAnswer").addEventListener("click", async () => {
  if (mesh || !pendingOffer) return;
  $("joinAnswer").disabled = true;
  try {
    ensureMesh(false);
    const answer = await mesh.joinWithOffer(pendingOffer);
    $("answerUrl").value = await buildCapabilityUrl("answer", roomId, answer);
    show("answerLabel", true); show("answerUrl", true);
    show("copyAnswer", true); show("mailAnswer", true);
    show("joinAnswer", false);
    status("Antwort erzeugt. Schick sie dem Host zurück — danach verbindet sich das Mesh automatisch.");
  } catch (err) {
    mesh = null; $("joinAnswer").disabled = false;
    status("Beitritt fehlgeschlagen: " + err.message);
  }
});

// --- Clipboard + mailto ----------------------------------------------------------
const copy = (id) => navigator.clipboard.writeText($(id).value).then(() => status("In die Zwischenablage kopiert."));
$("copyInvite").addEventListener("click", () => copy("inviteUrl"));
$("copyAnswer").addEventListener("click", () => copy("answerUrl"));
$("mailInvite").addEventListener("click", () => {
  location.href = mailtoLink("ultrathink.call — Einladung", "Tritt unserem Call bei, indem du diesen Link öffnest:", $("inviteUrl").value);
});
$("mailAnswer").addEventListener("click", () => {
  location.href = mailtoLink("ultrathink.call — Antwort", "Meine Antwort auf deine Einladung:", $("answerUrl").value);
});

// --- Screen sharing (applies to every peer) --------------------------------------
$("shareScreen").addEventListener("click", async () => {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    status("Bildschirm teilen wird auf diesem Browser/Gerät nicht unterstützt (z. B. mobil).");
    return;
  }
  // Pre-share warning (#30 / R-8): remind before any frame is sent.
  if (!confirm("Teile nur das gewünschte Fenster — andere Fenster und Benachrichtigungen könnten sichtbar werden. Fortfahren?")) return;
  try {
    const display = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: "window" } });
    const screenTrack = display.getVideoTracks()[0];
    for (const s of (mesh ? mesh.peers.values() : [])) await s.replaceVideo(screenTrack);
    sharing = true;
    $("localVideo").srcObject = display;
    show("deviceRow", false);
    $("shareScreen").disabled = true; $("stopShare").disabled = false;
    refreshBlurAvailability(); // blur applies to the camera, not the share — disable mid-share
    status("Bildschirm wird geteilt. Achte darauf, nur das gewünschte Fenster freizugeben.");
    screenTrack.addEventListener("ended", restoreCamera);
  } catch (err) {
    status("Screensharing abgebrochen: " + err.message);
  }
});
$("stopShare").addEventListener("click", restoreCamera);
async function restoreCamera() {
  sharing = false;
  camTrack = localStream.getVideoTracks()[0] || camTrack;
  for (const s of (mesh ? mesh.peers.values() : [])) if (camTrack) await s.replaceVideo(camTrack);
  $("localVideo").srcObject = localStream;
  show("deviceRow", true);
  $("shareScreen").disabled = false; $("stopShare").disabled = true;
  status("Zurück auf Kamera.");
  // The restored camera frame is unblurred until re-applied; re-assert the blur
  // state fail-closed so we never show the camera blurred when it is not (#25).
  refreshBlurAvailability();
  if (blurOn) {
    try { await applyBlur(true); }
    catch { revertBlur("Blur nach dem Teilen nicht wiederhergestellt — aus."); }
  }
}

// --- On load: auto-detect an invite in the URL -----------------------------------
(function detectInvite() {
  if (!inviteTokenInHash()) return;
  $("incomingIn").value = location.hash;
  parseIncoming(location.hash).then((p) => {
    if (isExpired(p)) { status(EXPIRED_MSG); return; }
    pendingOffer = p.sdp; roomId = p.room; setRoom();
    if (localStream) show("joinAnswer", true);
    status("Du wurdest eingeladen. Starte Kamera + Mikro, dann „Beitreten & Antwort erzeugen“.");
  }).catch((err) => status("Einladungs-Link konnte nicht gelesen werden: " + err.message));
})();
