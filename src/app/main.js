// UI Shell (BB-1) + Media Manager (BB-2) glue. A guided wizard (#46) drives a
// MeshSession: the host bootstraps each guest with a capability-URL, then the mesh
// forms automatically (ADR-8, no broker). Camera start and link creation are one
// step; controls appear with the call, not greyed-out beforehand. The host's
// pending connection lives only in this page's memory — so we make "keep the page
// open" explicit (keep-open note + beforeunload) and the answer is a copy/paste
// token, never an openable link (opening it would reload and destroy the call).
import { MeshSession } from "./mesh.js";
import { buildCapabilityUrl, parseIncoming, mailtoLink, isExpired, shareData, canNativeShare } from "./signaling.js";
import { AdaptController, TIERS, SAMPLE_INTERVAL_MS } from "./adapt.js";
import { NativeBlurProcessor, supportsBlur, UNSUPPORTED_MSG } from "./blur.js";

const INVITE_TTL_MS = 60 * 60 * 1000; // an invite link is valid for one hour (#29)
const EXPIRED_MSG = "Diese Einladung ist abgelaufen — bitte den Host um einen neuen Link.";
const INVITE_MSG = { subject: "ultrathink.call — Einladung", intro: "Tritt unserem Call bei, indem du diesen Link öffnest:", linkLabel: "ultrathink.call-Einladung" };
const ANSWER_MSG = { subject: "ultrathink.call — Antwort", intro: "Meine Antwort auf deine Einladung:" };

const $ = (id) => document.getElementById(id);
const status = (msg) => { $("status").textContent = msg; };
const show = (el, yes) => $(el).classList.toggle("hidden", !yes);

// The wizard's mutually-exclusive panels: exactly one — or "none" — is active
// (#50). Additive in-call surfaces (videos, callControls, inviteMore…) stay on
// their own targeted show() calls; folding them in here would force a false
// single-axis model.
const STEPS = { start: "stepStart", invite: "stepInvite", answer: "stepAnswer", guard: "answerGuard" };
function showStep(name) { for (const [k, id] of Object.entries(STEPS)) show(id, k === name); }

let mesh = null;
let localStream = null;
let camTrack = null;
let pendingOffer = null;       // guest: the host's offer awaiting join
let bootstrapPending = false;  // host: an invite is out, awaiting its answer
let sharing = false;           // a screen share is active
let blurOn = false;            // background blur requested by the user (#25)
let micMuted = false;          // local self-mute, mic (#47)
let camOff = false;            // local self-mute, camera (#47)
let roomId = null;

const getMedia = (c) => navigator.mediaDevices.getUserMedia(c);
const setRoom = () => { if (roomId) { $("roomLine").textContent = "Raum: " + roomId; show("roomLine", true); } };

// The host must not navigate away while a connection is pending — it lives only in
// memory (ADR-8). Warn on accidental unload; #leaveCall disarms before reloading.
let unloadGuard = null;
function armUnloadGuard() {
  if (unloadGuard) return;
  unloadGuard = (e) => { e.preventDefault(); e.returnValue = ""; };
  window.addEventListener("beforeunload", unloadGuard);
}
function disarmUnloadGuard() {
  if (unloadGuard) { window.removeEventListener("beforeunload", unloadGuard); unloadGuard = null; }
}

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
      onKicked: () => { clearRemoteTiles(); endAdapt(); disarmUnloadGuard(); mesh = null; status("Du wurdest vom Host aus dem Call entfernt."); },
    });
  }
  return mesh;
}

// --- Adaptive media under load (#27, R4): degrade, do not drop -------------------
const adapt = new AdaptController();
let adaptTimer = null;

function startAdapt() { if (!adaptTimer) adaptTimer = setInterval(sampleAdapt, SAMPLE_INTERVAL_MS); }
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

// On the first remote stream the connection stands: collapse the exchange UI.
async function onPeerConnected(id) {
  startAdapt();
  if (adapt.index > 0) await mesh?.peers.get(id)?.applyVideoParams(adapt.tier).catch(() => {});
  show("stepAnswer", false); // guest: the answer was accepted
}

// --- Phase 0: start media (camera/mic) + reveal in-call controls ------------------
async function startMedia() {
  if (localStream) return true;
  try {
    localStream = await getMedia({ video: true, audio: true });
    $("localVideo").srcObject = localStream;
    camTrack = localStream.getVideoTracks()[0] || null;
    show("videos", true); show("callControls", true);
    // Screen sharing exists only in desktop browsers (not iOS/Android) — #34.
    $("shareScreen").disabled = !navigator.mediaDevices?.getDisplayMedia;
    if (!navigator.mediaDevices?.getDisplayMedia) $("shareScreen").title = "Auf diesem Browser/Gerät nicht verfügbar (z. B. mobil).";
    refreshBlurAvailability(); // #25: only offer blur where the platform can deliver it
    await populateDevices();
    return true;
  } catch (err) {
    status("Kamera/Mikro-Zugriff fehlgeschlagen: " + err.message);
    return false;
  }
}

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
    // A fresh track is enabled by default — re-apply self-mute so a switch doesn't
    // silently unmute/turn the camera back on (#47).
    if (kind === "audio") applyMic();
    if (kind === "video") {
      applyCam();
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
const BLUR_OFF_LABEL = "Hintergrund verwischen";
const BLUR_ON_LABEL = "Hintergrund anzeigen";

function refreshBlurAvailability() {
  const ok = !sharing && !!camTrack && supportsBlur(camTrack);
  $("blurToggle").disabled = !ok;
  $("blurToggle").title = ok ? "" : UNSUPPORTED_MSG;
}

async function applyBlur(on) {
  blurOn = await new NativeBlurProcessor(camTrack).setEnabled(on);
  $("blurToggle").textContent = blurOn ? BLUR_ON_LABEL : BLUR_OFF_LABEL;
}

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

// --- Local self-mute (#47): toggle track.enabled, no renegotiation ----------------
// Distinct from host moderation (#28, receiver-side): this silences/blacks-out our
// own outgoing track. Re-applied after a device switch (a fresh track is enabled).
function applyMic() {
  const t = localStream?.getAudioTracks()[0];
  if (t) t.enabled = !micMuted;
  $("muteMic").textContent = micMuted ? "Mikro an" : "Mikro aus";
  show("localMicFlag", micMuted);
}
function applyCam() {
  const t = localStream?.getVideoTracks()[0];
  if (t) t.enabled = !camOff;
  $("muteCam").textContent = camOff ? "Kamera an" : "Kamera aus";
  show("localCamFlag", camOff);
}
$("muteMic").addEventListener("click", () => { micMuted = !micMuted; applyMic(); status(micMuted ? "Mikro aus." : "Mikro an."); });
$("muteCam").addEventListener("click", () => { camOff = !camOff; applyCam(); status(camOff ? "Kamera aus." : "Kamera an."); });

// --- The handshake: create an invite, ingest an invite/answer ---------------------
// Returns true once an invite exists, false on refusal/failure — so callers only
// commit UI transitions (hide start, arm the unload guard) on success.
async function createInvite() {
  if (bootstrapPending) { status("Es ist bereits eine Einladung offen — füge erst deren Antwort ein."); return false; }
  try {
    if (!roomId) { roomId = crypto.randomUUID(); setRoom(); }
    ensureMesh(true);
    const offer = await mesh.createBootstrapOffer();
    setLink("inviteLink", await buildCapabilityUrl("offer", roomId, offer, Date.now() + INVITE_TTL_MS), INVITE_MSG.linkLabel);
    applyShareChannels("shareInvite", "mailInvite");
    bootstrapPending = true;
    $("answerIn").value = "";
    showStep("invite");
    status("Einladung erstellt. Schick den Link, lass die Seite offen und füge die Antwort ein.");
    return true;
  } catch (err) {
    status("Einladung fehlgeschlagen: " + err.message);
    return false;
  }
}

async function ingestIncoming(text) {
  if (!text.trim()) return;
  try {
    const payload = await parseIncoming(text);
    if (payload.kind === "offer") {
      if (mesh && mesh.isHost) { status("Du bist Host — du kannst nicht deiner eigenen Einladung beitreten."); return; }
      if (isExpired(payload)) { status(EXPIRED_MSG); return; }
      pendingOffer = payload.sdp; roomId = payload.room; setRoom();
      showGuestStart();
      status("Einladung geladen. Klick „Beitreten“.");
    } else {
      if (!mesh || !mesh.isHost || !bootstrapPending) { status("Keine offene Einladung für diese Antwort."); return; }
      await mesh.acceptBootstrapAnswer(payload.sdp);
      bootstrapPending = false;
      clearLink("inviteLink"); $("answerIn").value = ""; show("shareInvite", false);
      showStep("none");
      status("Teilnehmer verbunden. Über „Weitere einladen“ kannst du weitere Personen hinzufügen.");
    }
  } catch (err) {
    status("Konnte Eingabe nicht lesen: " + err.message);
  }
}

function showGuestStart() {
  show("startHost", false); show("startGuest", true); showStep("start");
  $("guestRoom").textContent = roomId ? "Raum: " + roomId : "";
}

// Host: one step — camera + first invite. Only commit the phase transition once
// the invite actually exists, so a failed offer doesn't strand the start screen.
$("openCall").addEventListener("click", async () => {
  $("openCall").disabled = true;
  if (!(await startMedia())) { $("openCall").disabled = false; return; }
  if (await createInvite()) {   // createInvite shows the invite step on success
    show("inviteMore", true);
    armUnloadGuard();
  } else {
    $("openCall").disabled = false;
  }
});

// Guest: one step — camera + answer.
$("join").addEventListener("click", async () => {
  if (mesh || !pendingOffer) return;
  $("join").disabled = true;
  if (!(await startMedia())) { $("join").disabled = false; return; }
  try {
    ensureMesh(false);
    const answer = await mesh.joinWithOffer(pendingOffer);
    $("answerCode").value = await buildCapabilityUrl("answer", roomId, answer);
    applyShareChannels("shareAnswer", "mailAnswer");
    showStep("answer");
    armUnloadGuard();
    status("Antwort erzeugt. Schick sie dem Host zurück.");
  } catch (err) {
    mesh = null; $("join").disabled = false;
    status("Beitritt fehlgeschlagen: " + err.message);
  }
});

$("pasteLoad").addEventListener("click", () => ingestIncoming($("pasteIn").value));
$("answerLoad").addEventListener("click", () => ingestIncoming($("answerIn").value));
$("inviteMore").addEventListener("click", () => createInvite());
$("leaveCall").addEventListener("click", () => { disarmUnloadGuard(); mesh?.close(); mesh = null; location.reload(); });

// --- Distribution: native share / clipboard / mailto (#42) -----------------------
function applyShareChannels(shareId, mailId) {
  const native = canNativeShare();
  show(shareId, native);
  show(mailId, !native);
}

// The invite is shown as a compact link (#44): short text, full URL in href.
function setLink(id, url, label) { const a = $(id); a.href = url; a.textContent = label + " ↗"; show(id, true); }
function clearLink(id) { const a = $(id); a.removeAttribute("href"); a.textContent = ""; show(id, false); }
const linkUrl = (id) => $(id).getAttribute("href") || "";

const copyText = (text) => navigator.clipboard.writeText(text).then(() => status("In die Zwischenablage kopiert."));
$("copyInvite").addEventListener("click", () => copyText(linkUrl("inviteLink")));
$("copyAnswer").addEventListener("click", () => copyText($("answerCode").value));
$("guardCopy").addEventListener("click", () => copyText($("guardCode").value));

// navigator.share rejects with AbortError when the user dismisses the sheet — not
// an error. `err` is not guaranteed to be an Error, so reach in defensively.
async function sharePayload(data) {
  try { await navigator.share(data); }
  catch (err) { if (err?.name !== "AbortError") status("Teilen fehlgeschlagen: " + (err?.message ?? err)); }
}
$("shareInvite").addEventListener("click", () => sharePayload(shareData(INVITE_MSG.subject, INVITE_MSG.intro, linkUrl("inviteLink"))));
// The answer is shared as TEXT (no url field), so it is never a tap-to-open link (#46).
$("shareAnswer").addEventListener("click", () => sharePayload({ title: ANSWER_MSG.subject, text: ANSWER_MSG.intro + "\n\n" + $("answerCode").value }));
$("mailInvite").addEventListener("click", () => { location.href = mailtoLink(INVITE_MSG.subject, INVITE_MSG.intro, linkUrl("inviteLink")); });
$("mailAnswer").addEventListener("click", () => { location.href = mailtoLink(ANSWER_MSG.subject, ANSWER_MSG.intro, $("answerCode").value); });

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
    $("shareScreen").disabled = true; show("stopShare", true);
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
  $("shareScreen").disabled = false; show("stopShare", false);
  status("Zurück auf Kamera.");
  // The restored camera frame is unblurred until re-applied; re-assert fail-closed (#25).
  refreshBlurAvailability();
  if (blurOn) {
    try { await applyBlur(true); }
    catch { revertBlur("Blur nach dem Teilen nicht wiederhergestellt — aus."); }
  }
}

// --- On load: an invite (→ join) or an answer opened by mistake (→ guard) ---------
(function detectOnLoad() {
  if (!/#(invite|answer)=/.test(location.hash)) return;
  parseIncoming(location.hash).then((p) => {
    if (p.kind === "offer") {
      if (isExpired(p)) { status(EXPIRED_MSG); return; }
      pendingOffer = p.sdp; roomId = p.room; setRoom();
      showGuestStart();
      status("Du wurdest eingeladen. Klick „Beitreten“.");
    } else {
      // An #answer= link was opened — it belongs in the host's open call tab (#46).
      $("guardCode").value = location.href;
      showStep("guard");
      status("Das ist eine Antwort — kopiere sie und füge sie im Call-Tab ein.");
    }
  }).catch((err) => status("Link konnte nicht gelesen werden: " + err.message));
})();
