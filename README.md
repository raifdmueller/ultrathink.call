# ultrathink.call

A simple peer-to-peer WebRTC video call — **with no server of your own**. A
static page, runs straight from GitHub Pages.

See `src/docs/prd.adoc` for the product requirements and `CLAUDE.md` for the
engineering contract this project follows.

## Status: slice R1

A working vertical slice through every layer:

- **Media**: camera + microphone via `getUserMedia`, with **device selection**
  (switch camera/mic live via `replaceTrack`).
- **Connection**: `RTCPeerConnection`, peer-to-peer.
- **NAT**: public Google STUN, **no TURN** (deliberate limitation).
- **Signaling**: server-less. The SDP offer/answer is gzip-compressed and carried
  in the URL fragment (`#invite=`/`#answer=`), shared through the host's own mail
  client (`mailto:`). The room id is a CSPRNG UUIDv4.
- **Screen sharing**: `getDisplayMedia` + `replaceTrack` (no renegotiation).

No dependencies, no build. Opening `index.html` is enough.

## How it works (2 people)

1. **Host**: start camera + mic, then **Einladung erstellen**. Send the invite
   link via **Per E-Mail einladen** (or copy it).
2. **Guest**: open the link, start camera + mic, **Beitreten & Antwort
   erzeugen**, and send the answer link back to the host.
3. **Host**: paste the answer link into **Empfangen & verbinden** → **Laden /
   Übernehmen**. The call connects.

> Tip: to test locally, open `index.html` in two browser windows and pass the
> invite/answer links between them.

## Deliberate limitations (R1)

- **2 people only.** A full mesh for 4 (`4·3/2 = 6` connections) needs automatic
  signaling, which arrives in R2.
- **No TURN.** Behind symmetric NAT / strict firewalls a peer may fail to connect.
- **The invite link carries the host's public IP** (PRD risk R-6) — share it only
  with the people you invite.
- **No reconnect, no persistence.**

## Next slices (planned)

1. **R2** — 4-way mesh + automatic signaling over a sovereign (non-US) broker.
2. **R3** — client-side background blur for participant privacy.
3. **R4** — adaptive bitrate/resolution under load.
4. **R5** — training mode (~20), asymmetric topology (see issue #3).

## Hosting

Static, HTTPS included (WebRTC needs a secure context).

**GitHub Pages**: the workflow `.github/workflows/pages.yml` deploys the page on
every push to `main` (`index.html` is at the repo root, no build).

One-time setup: in the repo under **Settings → Pages → Build and deployment**,
choose source **"GitHub Actions"**. The app then lives at
`https://<user>.github.io/<project>/`.
