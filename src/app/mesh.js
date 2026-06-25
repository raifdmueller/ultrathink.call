// Mesh orchestration (ADR-8: no external broker). The host↔guest links are
// bootstrapped manually (capability-URL); the host then relays guest↔guest
// signaling over the ctrl data channels so a full mesh forms. The host relays
// only tiny SDP control messages — never media, which stays direct P2P.
import { PeerSession } from "./peer.js";

export class MeshSession {
  constructor({ stream, isHost, onPeerStream, onPeerLeave, onStatus, iceConfig }) {
    this.stream = stream;
    this.isHost = isHost;
    this.iceConfig = iceConfig;
    this.onPeerStream = onPeerStream || (() => {});
    this.onPeerLeave = onPeerLeave || (() => {});
    this.onStatus = onStatus || (() => {});
    this.selfId = isHost ? "host" : null;
    this.peers = new Map();           // peerId -> PeerSession
    this._pendingHostSession = null;  // host: bootstrap session awaiting an answer
    this._hostSession = null;         // guest: the connection to the host
    this._nextGuestNum = 0;
  }

  _newSession(extra) {
    let session;
    session = new PeerSession({
      stream: this.stream,
      iceConfig: this.iceConfig,
      onTrack: (s) => this.onPeerStream(session._peerId, s),
      onState: (st) => {
        this.onStatus(`${session._peerId || "peer"}: ${st}`);
        if (st === "failed" || st === "closed" || st === "disconnected") this._drop(session._peerId);
      },
      onCtrl: (msg) => this._handleCtrl(msg),
      ...extra,
    });
    return session;
  }

  _drop(id) {
    if (id && this.peers.has(id)) {
      this.peers.get(id).close();
      this.peers.delete(id);
      this.onPeerLeave(id);
    }
  }

  // --- Host: bootstrap a new guest -------------------------------------------
  async createBootstrapOffer() {
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
    await session.acceptAnswer(answer);
    // Tell the new guest its id and the existing guests to connect to.
    const others = [...this.peers.keys()].filter((k) => k !== id);
    session.sendCtrl({ t: "welcome", id, peers: others });
  }

  // --- Guest: join via the host's offer --------------------------------------
  async joinWithOffer(offer) {
    const session = this._newSession({ isOfferer: false });
    session._peerId = "host";
    this._hostSession = session;
    this.peers.set("host", session);
    return session.createAnswer(offer);
  }

  // --- Guest↔guest, relayed through the host ---------------------------------
  async _guestConnectTo(pid) {
    if (this.peers.has(pid)) return;
    const session = this._newSession({ isOfferer: true });
    session._peerId = pid;
    this.peers.set(pid, session);
    const offer = await session.createOffer();
    this._hostSession.sendCtrl({ t: "signal", to: pid, from: this.selfId, kind: "offer", sdp: offer });
  }

  async _guestAnswerFrom(fromId, offer) {
    const session = this._newSession({ isOfferer: false });
    session._peerId = fromId;
    this.peers.set(fromId, session);
    const answer = await session.createAnswer(offer);
    this._hostSession.sendCtrl({ t: "signal", to: fromId, from: this.selfId, kind: "answer", sdp: answer });
  }

  _handleCtrl(msg) {
    if (this.isHost) {
      // Host is a signaling conduit only: forward guest↔guest signals by `to`.
      if (msg.t === "signal" && msg.to !== "host") this.peers.get(msg.to)?.sendCtrl(msg);
      return;
    }
    if (msg.t === "welcome") {
      this.selfId = msg.id;
      for (const pid of msg.peers) this._guestConnectTo(pid);
    } else if (msg.t === "signal" && msg.to === this.selfId) {
      if (msg.kind === "offer") this._guestAnswerFrom(msg.from, msg.sdp);
      else if (msg.kind === "answer") this.peers.get(msg.from)?.acceptAnswer(msg.sdp);
    }
  }

  close() {
    for (const s of this.peers.values()) s.close();
    this.peers.clear();
  }
}
