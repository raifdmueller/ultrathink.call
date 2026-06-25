# ultrathink.call

Ein einfacher P2P-WebRTC-Videocall — **ohne eigenen Server**. Statische Seite,
läuft direkt auf GitLab Pages oder GitHub Pages.

## Stand: Walking Skeleton

Der erste vertikale Slice durch alle Schichten:

- **Medien**: Kamera + Mikrofon via `getUserMedia`
- **Verbindung**: `RTCPeerConnection`, Peer-to-Peer
- **NAT**: öffentlicher Google-STUN, **kein TURN** (bewusste Einschränkung)
- **Signaling**: manueller SDP-Austausch per Copy-Paste, **2 Personen**
- **Screensharing**: `getDisplayMedia` + `replaceTrack` (ohne Renegotiation)

Keine Dependencies, kein Build. `index.html` öffnen reicht.

## Ablauf (2 Personen)

1. Beide: **Kamera + Mikro starten**.
2. Caller: **Anruf starten** → Offer wird erzeugt → **Offer kopieren** und dem Callee senden.
3. Callee: Offer einfügen → **Answer erzeugen** → **Answer kopieren** und dem Caller zurücksenden.
4. Caller: Answer einfügen → **Answer übernehmen**. Verbindung steht.

> Tipp: Lokal mit zwei Browser-Tabs/Fenstern testen. SDP zwischen den Tabs hin- und herkopieren.

## Bewusste Grenzen dieses Skeletons

- **Nur 2 Personen.** Full-Mesh für 4 Teilnehmer braucht `4·3/2 = 6` Verbindungen
  und macht manuelles Copy-Paste unpraktikabel (12 Schritte pro Meeting).
- **Kein TURN.** Hinter symmetrischem NAT/strenger Firewall kann ein Peer ausfallen.
- **Kein Reconnect, keine Persistenz.**

## Nächste Slices (geplant)

1. **Mesh für 4 Teilnehmer** — eine `RTCPeerConnection` pro Peer-Paar.
2. **Serverloses Signaling** statt Copy-Paste — z. B. Trystero über öffentliche
   Broker (BitTorrent/Nostr/MQTT), damit das Mesh-Setup automatisch läuft.
3. Optional **TURN** für robuste NAT-Traversal (dann nicht mehr rein serverlos).

## Hosting

Rein statisch, HTTPS inklusive (WebRTC braucht einen sicheren Kontext).

**GitHub Pages**: Der Workflow `.github/workflows/pages.yml` deployt die Seite
automatisch bei jedem Push auf `main` (`index.html` liegt im Root, kein Build).

Einmalig nötig: im Repo unter **Settings → Pages → Build and deployment** als
Source **„GitHub Actions"** wählen. Danach liegt die App unter
`https://<user>.github.io/<projekt>/`.
