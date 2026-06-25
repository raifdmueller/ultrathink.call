// Peer Connection (BB-3) — one RTCPeerConnection, its media, and an optional
// control data channel ("ctrl") used by the mesh to relay guest↔guest signaling
// over the host (no external broker — ADR-8). A mesh is a map of PeerSessions.

export const ICE_CONFIG = { iceServers: [{ urls: "stun:stun.nextcloud.com:443" }] };
export const ICE_TIMEOUT_MS = 4000;
export const MAX_CTRL = 200000; // cap an inbound ctrl message (anti-DoS), mirrors MAX_TOKEN

// Non-trickle ICE: resolve on completion or a timeout so one payload carries all
// candidates (a stalled gather still ships what it has).
export function waitForIce(peer, timeoutMs = ICE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    if (peer.iceGatheringState === "complete") return resolve();
    const done = () => { peer.removeEventListener("icegatheringstatechange", check); clearTimeout(t); resolve(); };
    const check = () => { if (peer.iceGatheringState === "complete") done(); };
    const t = setTimeout(done, timeoutMs);
    peer.addEventListener("icegatheringstatechange", check);
  });
}

export class PeerSession {
  // isOfferer creates the ctrl data channel; the answerer receives it.
  constructor({ stream, isOfferer = false, onTrack, onState, onCtrl, iceConfig = ICE_CONFIG }) {
    this.pc = new RTCPeerConnection(iceConfig);
    this.videoSender = null;
    this.audioSender = null;
    this.ctrl = null;
    this._ctrlQueue = [];
    this._onCtrl = onCtrl;

    this.pc.addEventListener("track", (e) => onTrack && onTrack(e.streams[0]));
    this.pc.addEventListener("connectionstatechange", () => onState && onState(this.pc.connectionState));

    if (isOfferer) {
      this._wireCtrl(this.pc.createDataChannel("ctrl"));
    } else {
      this.pc.addEventListener("datachannel", (e) => {
        if (e.channel.label === "ctrl") this._wireCtrl(e.channel);
      });
    }

    if (stream) {
      for (const track of stream.getTracks()) {
        const sender = this.pc.addTrack(track, stream);
        if (track.kind === "video") this.videoSender = sender;
        if (track.kind === "audio") this.audioSender = sender;
      }
    }
  }

  _wireCtrl(ch) {
    this.ctrl = ch;
    ch.addEventListener("message", (e) => {
      if (typeof e.data !== "string" || e.data.length > MAX_CTRL) return; // size cap
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }                // drop malformed
      this._onCtrl && this._onCtrl(msg);
    });
    const flush = () => { for (const m of this._ctrlQueue) ch.send(m); this._ctrlQueue = []; };
    if (ch.readyState === "open") flush();          // the open event may have already fired
    else ch.addEventListener("open", flush);
  }

  // Send a control object; queues until the channel opens.
  sendCtrl(obj) {
    const data = JSON.stringify(obj);
    if (this.ctrl && this.ctrl.readyState === "open") this.ctrl.send(data);
    else this._ctrlQueue.push(data);
  }

  async createOffer() {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await waitForIce(this.pc);
    return this.pc.localDescription;
  }

  async createAnswer(remoteOffer) {
    await this.pc.setRemoteDescription(remoteOffer);
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await waitForIce(this.pc);
    return this.pc.localDescription;
  }

  async acceptAnswer(remoteAnswer) {
    await this.pc.setRemoteDescription(remoteAnswer);
  }

  async replaceVideo(track) { if (this.videoSender) await this.videoSender.replaceTrack(track); }
  async replaceAudio(track) { if (this.audioSender) await this.audioSender.replaceTrack(track); }

  get state() { return this.pc.connectionState; }
  close() { this.pc.close(); }
}
