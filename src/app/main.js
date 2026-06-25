// UI Shell (BB-1) + Media Manager (BB-2) glue. Drives a MeshSession: the host
// bootstraps each guest with a capability-URL, then the mesh forms automatically
// (ADR-8, no broker). One video tile per peer; device/screen changes apply to all.
import { MeshSession } from "./mesh.js";
import { buildCapabilityUrl, parseIncoming, mailtoLink, inviteTokenInHash } from "./signaling.js";

const $ = (id) => document.getElementById(id);
const status = (msg) => { $("status").textContent = msg; };
const show = (el, yes) => $(el).classList.toggle("hidden", !yes);

let mesh = null;
let localStream = null;
let camTrack = null;
let pendingOffer = null;       // guest: the host's offer awaiting join
let bootstrapPending = false;  // host: an invite is out, awaiting its answer
let sharing = false;           // a screen share is active
let roomId = null;

const setRoom = () => { if (roomId) $("roomLine").textContent = "Raum: " + roomId; };
const getMedia = (c) => navigator.mediaDevices.getUserMedia(c);

// --- remote tiles, one per peer --------------------------------------------------
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
    $("videos").appendChild(tile);
  }
  tile.querySelector("video").srcObject = stream;
}
const removeTile = (peerId) => document.getElementById("tile-" + peerId)?.remove();

function ensureMesh(isHost) {
  if (!mesh) {
    mesh = new MeshSession({
      stream: localStream,
      isHost,
      onPeerStream: (id, s) => setTile(id, s),
      onPeerLeave: (id) => removeTile(id),
      onStatus: (m) => status(m),
    });
  }
  return mesh;
}

const eachPeer = (fn) => { if (mesh) for (const s of mesh.peers.values()) fn(s); };

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
  } catch (err) {
    status("Gerätewechsel fehlgeschlagen: " + err.message);
  }
}
$("camSelect").addEventListener("change", () => switchTrack("video", $("camSelect").value));
$("micSelect").addEventListener("change", () => switchTrack("audio", $("micSelect").value));

// --- Host: create an invite for the next guest -----------------------------------
$("createInvite").addEventListener("click", async () => {
  if (bootstrapPending) { status("Es ist bereits eine Einladung offen — füge erst deren Antwort ein."); return; }
  if (mesh && !mesh.isHost) { status("Du bist als Gast beigetreten."); return; }
  $("createInvite").disabled = true;
  try {
    if (!roomId) { roomId = crypto.randomUUID(); setRoom(); }
    ensureMesh(true);
    const offer = await mesh.createBootstrapOffer();
    $("inviteUrl").value = await buildCapabilityUrl("offer", roomId, offer);
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
  try {
    const display = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: "window" } });
    const screenTrack = display.getVideoTracks()[0];
    for (const s of (mesh ? mesh.peers.values() : [])) await s.replaceVideo(screenTrack);
    sharing = true;
    $("localVideo").srcObject = display;
    show("deviceRow", false);
    $("shareScreen").disabled = true; $("stopShare").disabled = false;
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
}

// --- On load: auto-detect an invite in the URL -----------------------------------
(function detectInvite() {
  if (!inviteTokenInHash()) return;
  $("incomingIn").value = location.hash;
  parseIncoming(location.hash).then((p) => {
    pendingOffer = p.sdp; roomId = p.room; setRoom();
    if (localStream) show("joinAnswer", true);
    status("Du wurdest eingeladen. Starte Kamera + Mikro, dann „Beitreten & Antwort erzeugen“.");
  }).catch((err) => status("Einladungs-Link konnte nicht gelesen werden: " + err.message));
})();
