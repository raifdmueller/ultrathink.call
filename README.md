# ultrathink.call

A simple peer-to-peer WebRTC video call — **with no server of your own**. A
static page, runs straight from GitHub Pages.

See `src/docs/prd.adoc` for the product requirements and `CLAUDE.md` for the
engineering contract this project follows.

## Status: R2 — four-peer mesh

A working vertical slice through every layer:

- **Media**: camera + microphone via `getUserMedia`, with **device selection**
  (switch camera/mic live via `replaceTrack`).
- **Mesh**: a full mesh of up to four peers. The host bootstraps each guest with
  a capability-URL, then **relays guest↔guest signaling over data channels** so
  everyone connects directly — **no broker, no server** (ADR-8). Media stays
  peer-to-peer; the host only forwards tiny SDP messages.
- **NAT**: sovereign STUN (Nextcloud, DE), **no TURN** (deliberate limitation).
- **Signaling**: server-less. The SDP is gzip-compressed and carried in the URL
  fragment (`#invite=`/`#answer=`), shared via the host's own `mailto:`. The room
  id is a CSPRNG UUIDv4.
- **Screen sharing**: `getDisplayMedia` + `replaceTrack` (no renegotiation).

No runtime dependencies, no build — the app is static ES modules. `vitest` +
Playwright are dev-only tooling.

## How it works (up to 4 people)

1. **Host**: start camera + mic, then **Einladung erstellen** → send the invite
   link to one guest. Paste their answer into **Empfangen & verbinden**. Repeat
   **once per guest**.
2. **Guest**: open the link, start camera + mic, **Beitreten & Antwort
   erzeugen**, and send the answer link back to the host.
3. Once two or more guests are in, the **guests connect to each other
   automatically** through the host relay — a full mesh.

> Tip: to test locally, run `npm run e2e` (drives a real 3-peer mesh), or open
> several browser windows and pass the invite/answer links between them.

## Deliberate limitations (R2)

- **Up to ~4 people.** A full mesh has every peer upload to every other; ~20
  needs a different topology (open decision, issue #3).
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
