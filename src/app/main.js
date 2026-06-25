// UI Shell (BB-1) + Media Manager (BB-2) glue. Wires the DOM to the codec,
// PeerSession, and the manual signaling adapter. Single peer at R1; the mesh
// (a map of PeerSessions) arrives in R2 (issue #21).
import { PeerSession } from "./peer.js";
import { buildCapabilityUrl, parseIncoming, mailtoLink, inviteTokenInHash } from "./signaling.js";

const $ = (id) => document.getElementById(id);
const status = (msg) => { $("status").textContent = msg; };
const show = (el, yes) => $(el).classList.toggle("hidden", !yes);

let session = null;       // the single PeerSession (mesh = a map of these in R2)
let localStream = null;
let camTrack = null;
let pendingOffer = null;
let roomId = null;

const setRoom = () => { if (roomId) $("roomLine").textContent = "Raum: " + roomId; };
const getMedia = (c) => navigator.mediaDevices.getUserMedia(c);

function newSession() {
  session = new PeerSession({
    stream: localStream,
    onTrack: (stream) => { $("remoteVideo").srcObject = stream; },
    onState: (st) => {
      status("Verbindung: " + st);
      if (st === "failed") status("Verbindung fehlgeschlagen (evtl. NAT/Firewall — kein TURN).");
    },
  });
  camTrack = localStream.getVideoTracks()[0] || null;
  return session;
}

// --- Step 1: media + device list -------------------------------------------------
$("startCam").addEventListener("click", async () => {
  try {
    localStream = await getMedia({ video: true, audio: true });
    $("localVideo").srcObject = localStream;
    $("startCam").disabled = true;
    $("shareScreen").disabled = false;
    $("createInvite").disabled = false;
    if (pendingOffer) show("joinAnswer", true);
    await populateDevices();
    show("deviceRow", true);
    status(pendingOffer
      ? "Kamera läuft. Du wurdest eingeladen — jetzt „Beitreten & Antwort erzeugen“."
      : "Kamera läuft. Lade jemanden über „Einladung erstellen“ ein.");
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

async function switchDevices() {
  try {
    const next = await getMedia({
      video: { deviceId: { exact: $("camSelect").value } },
      audio: { deviceId: { exact: $("micSelect").value } },
    });
    const v = next.getVideoTracks()[0], a = next.getAudioTracks()[0];
    if (session) { await session.replaceVideo(v); await session.replaceAudio(a); }
    localStream.getTracks().forEach((t) => t.stop());
    localStream = next; camTrack = v;
    $("localVideo").srcObject = next;
    status("Gerät gewechselt.");
  } catch (err) {
    status("Gerätewechsel fehlgeschlagen: " + err.message);
  }
}
$("camSelect").addEventListener("change", switchDevices);
$("micSelect").addEventListener("change", switchDevices);

// --- Host: create invite ---------------------------------------------------------
$("createInvite").addEventListener("click", async () => {
  if (session) { status("Es ist bereits eine Einladung offen."); return; }
  $("createInvite").disabled = true;
  try {
    roomId = crypto.randomUUID(); setRoom();
    newSession();
    const offer = await session.createOffer();
    $("inviteUrl").value = await buildCapabilityUrl("offer", roomId, offer);
    $("copyInvite").disabled = false; $("mailInvite").disabled = false;
    status("Einladung erstellt. Schick den Link per E-Mail und füge unten die Antwort ein.");
  } catch (err) {
    session = null; $("createInvite").disabled = false;
    status("Einladung fehlgeschlagen: " + err.message);
  }
});

// --- Load an incoming invite or answer -------------------------------------------
$("loadIncoming").addEventListener("click", async () => {
  const text = $("incomingIn").value;
  if (!text.trim()) return;
  try {
    const payload = await parseIncoming(text);
    if (payload.kind === "offer") {
      if (session) { status("Du hast schon eine eigene Einladung offen — du kannst nicht deiner eigenen beitreten."); return; }
      pendingOffer = payload.sdp; roomId = payload.room; setRoom();
      show("joinAnswer", localStream != null);
      status(localStream
        ? "Einladung geladen. Jetzt „Beitreten & Antwort erzeugen“."
        : "Einladung geladen. Starte zuerst Kamera + Mikro, dann beitreten.");
    } else {
      if (!session) { status("Es gibt keine offene Einladung für diese Antwort."); return; }
      await session.acceptAnswer(payload.sdp);
      status("Antwort übernommen — Verbindung wird aufgebaut …");
    }
  } catch (err) {
    status("Konnte Eingabe nicht lesen: " + err.message);
  }
});

// --- Guest: join and produce an answer -------------------------------------------
$("joinAnswer").addEventListener("click", async () => {
  if (session || !pendingOffer) return;
  $("joinAnswer").disabled = true;
  try {
    newSession();
    const answer = await session.createAnswer(pendingOffer);
    $("answerUrl").value = await buildCapabilityUrl("answer", roomId, answer);
    show("answerLabel", true); show("answerUrl", true);
    show("copyAnswer", true); show("mailAnswer", true);
    show("joinAnswer", false);
    status("Antwort erzeugt. Schick sie dem Host zurück.");
  } catch (err) {
    session = null; $("joinAnswer").disabled = false;
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

// --- Screen sharing --------------------------------------------------------------
$("shareScreen").addEventListener("click", async () => {
  try {
    const display = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: "window" } });
    const screenTrack = display.getVideoTracks()[0];
    if (session) await session.replaceVideo(screenTrack);
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
  camTrack = localStream.getVideoTracks()[0] || camTrack;
  if (session && camTrack) await session.replaceVideo(camTrack);
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
