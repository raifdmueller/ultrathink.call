// Mesh orchestration (ADR-8: no external broker). Host↔guest links are
// bootstrapped manually (capability-URL); the host then relays guest↔guest SDP
// over the ctrl data channels until a full mesh forms. The host relays only tiny
// SDP control messages — never media, which stays direct P2P (DTLS-SRTP).
//
// Trust model: the host is trusted (it is the meeting organizer). A malicious
// host could MITM guest↔guest media because it relays their SDP (R-7, accepted
// residual of the no-broker design). Guests are NOT trusted: relayed SDP is
// validated (DTLS fingerprint, VR-9) and the host stamps the authoritative
// sender id, so a guest cannot downgrade encryption or spoof another peer.
import { PeerSession } from "./peer.js";

export const MAX_PEERS = 8; // ceiling on simultaneous connections (anti-DoS)
export const MAX_CHAT = 2000; // cap a chat line (#48); the ctrl channel caps the whole frame

// Reject any remote description that is not a well-formed, DTLS-encrypted SDP of
// the expected kind — the mesh path's equivalent of the capability-URL's VR-9.
function validRemoteSdp(sdp, kind) {
  return !!sdp && sdp.type === kind && typeof sdp.sdp === "string" && /a=fingerprint:/i.test(sdp.sdp);
}

export class MeshSession {
  constructor({ stream, isHost, onPeerStream, onPeerLeave, onStatus, onKicked, onChat, iceConfig }) {
    this.stream = stream;
    this.isHost = isHost;
    this.iceConfig = iceConfig;
    this.onPeerStream = onPeerStream || (() => {});
    this.onPeerLeave = onPeerLeave || (() => {});
    this.onStatus = onStatus || (() => {});
    this.onKicked = onKicked || (() => {}); // guest: the host evicted us
    this.onChat = onChat || (() => {});     // a chat line arrived (#48)
    this._mutedIds = new Set();             // authoritative muted-peer set (#37)
    this.selfId = isHost ? "host" : null;
    this.peers = new Map();           // peerId -> PeerSession
    this._pendingHostSession = null;  // host: bootstrap session awaiting an answer
    this._hostSession = null;         // guest: the connection to the host
    this._nextGuestNum = 0;
  }

  setStream(stream) { this.stream = stream; } // so peers formed after a device switch use the new tracks

  _newSession(extra) {
    const session = new PeerSession({
      stream: this.stream,
      iceConfig: this.iceConfig,
      // Re-assert mute on every fresh track (#37): a peer muted before this link
      // existed (or before its stream arrived) must still come in silenced.
      onTrack: (s) => { if (this._mutedIds.has(session._peerId)) session.setRemoteAudioEnabled(false); this.onPeerStream(session._peerId, s); },
      onState: (st) => {
        this.onStatus(`${session._peerId || "peer"}: ${st}`);
        // "disconnected" is transient and recovers on its own — only tear down on terminal states.
        if (st === "failed" || st === "closed") this._drop(session._peerId);
      },
      onCtrl: (msg) => this._handleCtrl(session, msg),
      ...extra,
    });
    return session;
  }

  _atCapacity() { return this.peers.size >= MAX_PEERS; }

  _drop(id) {
    if (id && this.peers.has(id)) {
      this.peers.get(id).close();
      this.peers.delete(id);
      this.onPeerLeave(id);
    }
  }

  // --- Host: bootstrap a new guest -------------------------------------------
  async createBootstrapOffer() {
    if (this._atCapacity()) throw new Error("Maximale Teilnehmerzahl erreicht.");
    const session = this._newSession({ isOfferer: true });
    this._pendingHostSession = session;
    return session.createOffer();
  }

  async acceptBootstrapAnswer(answer) {
    const session = this._pendingHostSession;
    if (!session) throw new Error("Keine offene Einladung.");
    this._pendingHostSession = null;
    const id = "p" + (++this._nextGuestNum);
    session._peerId = id;
    this.peers.set(id, session);
    await session.acceptAnswer(answer); // answer arrived via the validated capability-URL path
    const others = [...this.peers.keys()].filter((k) => k !== id);
    // Replay the muted set so a late joiner silences already-muted peers (#37).
    session.sendCtrl({ t: "welcome", id, peers: others, muted: [...this._mutedIds] });
  }

  // --- Guest: join via the host's offer --------------------------------------
  async joinWithOffer(offer) {
    if (!validRemoteSdp(offer, "offer")) throw new Error("Ungültiges Offer.");
    const session = this._newSession({ isOfferer: false });
    session._peerId = "host";
    this._hostSession = session;
    this.peers.set("host", session);
    return session.createAnswer(offer);
  }

  // --- Guest↔guest, relayed through the host ---------------------------------
  async _guestConnectTo(pid) {
    if (this.peers.has(pid) || this._atCapacity()) return;
    const session = this._newSession({ isOfferer: true });
    session._peerId = pid;
    this.peers.set(pid, session);
    const offer = await session.createOffer();
    this._hostSession.sendCtrl({ t: "signal", to: pid, from: this.selfId, kind: "offer", sdp: offer });
  }

  async _guestAnswerFrom(fromId, offer) {
    if (this.peers.has(fromId) || this._atCapacity()) return; // glare / duplicate guard
    if (!validRemoteSdp(offer, "offer")) return;
    const session = this._newSession({ isOfferer: false });
    session._peerId = fromId;
    this.peers.set(fromId, session);
    const answer = await session.createAnswer(offer);
    this._hostSession.sendCtrl({ t: "signal", to: fromId, from: this.selfId, kind: "answer", sdp: answer });
  }

  // Control protocol: `welcome` (host→new guest: your id + peers to connect to)
  // and `signal` (offer/answer, relayed by the host, routed by `to`).
  // --- Host moderation (only the host may issue these) -----------------------
  kick(id) {
    if (!this.isHost) return;
    for (const s of this.peers.values()) s.sendCtrl({ t: "kick", id });
    this._drop(id);
  }

  setMuted(id, muted) {
    if (!this.isHost) return;
    if (muted) this._mutedIds.add(id); else this._mutedIds.delete(id); // authoritative (#37)
    for (const s of this.peers.values()) s.sendCtrl({ t: "mute", id, muted });
    this.peers.get(id)?.setRemoteAudioEnabled(!muted); // apply at the host too
  }

  isMuted(id) { return this._mutedIds.has(id); } // host UI derives the label from this (#37)

  // --- Chat (#48): direct peer-to-peer over the established mesh, no relay ----
  // Broadcast to every directly-connected peer. Returns the capped text the
  // sender displays for itself.
  sendChat(text) {
    const t = String(text).slice(0, MAX_CHAT);
    if (t) for (const s of this.peers.values()) s.sendCtrl({ t: "chat", text: t });
    return t;
  }

  _handleCtrl(session, msg) {
    if (!msg || typeof msg.t !== "string") return;

    // Chat is handled by both roles. Attribute it to the channel it arrived on
    // (session._peerId), never a claimed `from` — a peer cannot impersonate.
    if (msg.t === "chat") {
      if (typeof msg.text === "string" && msg.text.length <= MAX_CHAT) {
        this.onChat(session._peerId || "peer", msg.text);
      }
      return;
    }

    if (this.isHost) {
      // Conduit only. The authoritative sender is the channel it arrived on —
      // never trust a guest's claimed `from` (prevents impersonation).
      if (msg.t === "signal" && typeof msg.to === "string" && msg.to !== "host") {
        const target = this.peers.get(msg.to);
        if (target) target.sendCtrl({ ...msg, from: session._peerId });
      }
      return;
    }

    // Guest: moderation is honored only from the host channel.
    if ((msg.t === "kick" || msg.t === "mute") && session === this._hostSession && typeof msg.id === "string") {
      if (msg.t === "kick") {
        // The host can kick us (our own selfId) or another guest. If it is us,
        // tear the whole mesh down — otherwise the kicked client keeps every
        // PeerConnection open and goes on sending media to peers that haven't
        // yet noticed (its own peers map never holds its own selfId).
        if (msg.id === this.selfId) { this.onKicked(); this.close(); }
        else this._drop(msg.id);
      } else {
        if (msg.muted) this._mutedIds.add(msg.id); else this._mutedIds.delete(msg.id); // track for late tracks (#37)
        this.peers.get(msg.id)?.setRemoteAudioEnabled(!msg.muted);
      }
      return;
    }

    if (msg.t === "welcome") {
      if (session !== this._hostSession) return;               // welcome only from the host
      if (typeof msg.id !== "string" || !Array.isArray(msg.peers)) return;
      this.selfId = msg.id;
      // Inherit the muted set so peers we connect to next come in silenced (#37).
      if (Array.isArray(msg.muted)) for (const m of msg.muted) if (typeof m === "string") this._mutedIds.add(m);
      for (const pid of msg.peers) if (typeof pid === "string") this._guestConnectTo(pid);
    } else if (msg.t === "signal" && msg.to === this.selfId && typeof msg.from === "string") {
      if (msg.kind === "offer") {
        this._guestAnswerFrom(msg.from, msg.sdp);
      } else if (msg.kind === "answer" && validRemoteSdp(msg.sdp, "answer")) {
        this.peers.get(msg.from)?.acceptAnswer(msg.sdp);
      }
    }
  }

  close() {
    for (const s of this.peers.values()) s.close();
    this.peers.clear();
  }
}
