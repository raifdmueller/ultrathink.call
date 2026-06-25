// Peer Connection (BB-3) — one RTCPeerConnection, its media, and an optional
// control data channel ("ctrl") used by the mesh to relay guest↔guest signaling
// over the host (no external broker — ADR-8). A mesh is a map of PeerSessions.

// Sovereign (non-US) STUN set with fallbacks (D-9). All endpoints are operated in
// the EU (DE); ICE tries them all and uses whichever responds. Uptime/vetting is
// an operational concern (R-2). No US provider here (SM-2).
export const ICE_CONFIG = {
  iceServers: [
    { urls: [
      "stun:stun.nextcloud.com:443", // Nextcloud GmbH (DE)
      "stun:stun.sipgate.net:3478",  // sipgate GmbH (DE)
      "stun:stun.1und1.de:3478",     // 1&1 / IONOS (DE)
    ] },
  ],
};
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
  constructor({ stream, isOfferer = false, onTrack, onScreenTrack, onState, onCtrl, iceConfig = ICE_CONFIG }) {
    this.pc = new RTCPeerConnection(iceConfig);
    this.videoSender = null;
    this.audioSender = null;
    this.screenSender = null;   // the reserved second video slot (#67)
    this.ctrl = null;
    this._ctrlQueue = [];
    this._onCtrl = onCtrl;
    this.remoteStream = null;
    this.screenStream = null;

    // Two video transceivers per peer: the camera and a reserved screen slot.
    // Tell their incoming tracks apart by the msid: camera and mic are added with
    // the main stream (so they arrive with a populated `e.streams`), while the
    // screen slot is added with no stream — its track arrives with empty
    // `e.streams`. That presence test is the routing key (#67).
    this.pc.addEventListener("track", (e) => {
      if (e.streams && e.streams[0]) {
        this.remoteStream = e.streams[0];
        onTrack && onTrack(e.streams[0]);
      } else {
        this.screenStream = new MediaStream([e.track]);
        onScreenTrack && onScreenTrack(this.screenStream);
      }
    });
    this.pc.addEventListener("connectionstatechange", () => onState && onState(this.pc.connectionState));

    if (isOfferer) {
      this._wireCtrl(this.pc.createDataChannel("ctrl"));
    } else {
      this.pc.addEventListener("datachannel", (e) => {
        if (e.channel.label === "ctrl") this._wireCtrl(e.channel);
      });
    }

    // Camera + mic via addTrack (with the main stream, so the remote gets the
    // msid that the track-routing above keys on). Then a SECOND video transceiver
    // is reserved empty at bootstrap — the screen slot — so a screen can later be
    // sent via replaceTrack WITHOUT renegotiation (the mesh never renegotiates
    // after connect, ADR-8, #67).
    if (stream) {
      for (const track of stream.getTracks()) {
        const sender = this.pc.addTrack(track, stream);
        if (track.kind === "video") this.videoSender = sender;
        if (track.kind === "audio") this.audioSender = sender;
      }
    }
    // Only the OFFERER reserves the screen transceiver here. A pre-added
    // transceiver on the answerer does NOT associate with the offer's screen
    // m-line (the browser orphans it and answers the m-line recvonly), so the
    // answerer would never be able to share. The answerer instead claims and
    // promotes the offered slot to sendrecv in createAnswer().
    if (isOfferer) {
      this.screenSender = this.pc.addTransceiver("video", { direction: "sendrecv" }).sender;
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
    // Claim the offered screen slot (#67) and make it bidirectional so we can
    // share too — otherwise the answered m-line defaults to recvonly. It is the
    // lone video transceiver carrying no outgoing track of our own (camera/mic
    // were added with addTrack and own their senders).
    if (!this.screenSender) {
      const trx = this.pc.getTransceivers().find((t) => t.receiver.track?.kind === "video" && !t.sender.track);
      if (trx) { trx.direction = "sendrecv"; this.screenSender = trx.sender; }
    }
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
  // Push a screen track into the reserved slot (#67), or null to stop sharing.
  async replaceScreen(track) { if (this.screenSender) await this.screenSender.replaceTrack(track); }

  // Outbound video health for the adaptive controller (#27, BB-8). Returns the
  // browser's own quality-limitation verdict ("cpu" | "bandwidth" | "none") and
  // the current send framerate, or null if there is no video sender yet.
  async videoLimitation() {
    if (!this.videoSender) return null;
    const stats = await this.pc.getStats(this.videoSender.track);
    let reason = "none", fps = null;
    stats.forEach((r) => {
      if (r.type === "outbound-rtp" && r.kind === "video") {
        // Prefer a limiting verdict; under simulcast keep the worst, not the last.
        if (r.qualityLimitationReason && r.qualityLimitationReason !== "none") reason = r.qualityLimitationReason;
        if (typeof r.framesPerSecond === "number") fps = fps === null ? r.framesPerSecond : Math.min(fps, r.framesPerSecond);
      }
    });
    return { reason, fps };
  }

  // Apply an encoding tier to the outgoing video (#27): scale the resolution and
  // cap the framerate via setParameters — the standard adaptive lever, applied to
  // the same local track every peer receives.
  async applyVideoParams({ scaleResolutionDownBy, maxFramerate }) {
    if (!this.videoSender) return;
    const params = this.videoSender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    params.encodings[0].scaleResolutionDownBy = scaleResolutionDownBy;
    params.encodings[0].maxFramerate = maxFramerate;
    await this.videoSender.setParameters(params);
  }

  // Receiver-side mute: disable the incoming audio from this peer for us.
  setRemoteAudioEnabled(on) { this.remoteStream?.getAudioTracks().forEach((t) => { t.enabled = on; }); }

  get state() { return this.pc.connectionState; }
  close() { this.pc.close(); }
}
