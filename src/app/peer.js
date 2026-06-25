// Peer Connection (BB-3) — one RTCPeerConnection and its media, wrapped so the
// R2 mesh becomes a map of PeerSessions instead of a global rewrite (retires TD-4).

export const ICE_CONFIG = { iceServers: [{ urls: "stun:stun.nextcloud.com:443" }] };
export const ICE_TIMEOUT_MS = 4000;

// Non-trickle ICE: resolve on completion or a timeout so one payload carries all
// candidates and a single link suffices (a stalled gather still ships candidates).
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
  constructor({ stream, onTrack, onState, iceConfig = ICE_CONFIG }) {
    this.pc = new RTCPeerConnection(iceConfig);
    this.videoSender = null;
    this.audioSender = null;
    this.pc.addEventListener("track", (e) => onTrack && onTrack(e.streams[0]));
    this.pc.addEventListener("connectionstatechange", () => onState && onState(this.pc.connectionState));
    for (const track of stream.getTracks()) {
      const sender = this.pc.addTrack(track, stream);
      if (track.kind === "video") this.videoSender = sender;
      if (track.kind === "audio") this.audioSender = sender;
    }
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
