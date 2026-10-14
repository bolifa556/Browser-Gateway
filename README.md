# Browser Gateway

English | [简体中文](README.zh-CN.md)

A self-hosted, server-side browser gateway: run a real browser on a Linux server
and interact with an existing website from an ordinary client browser.

The server handles website rendering, its persistent browser profile, and
upstream network access. Clients receive a lossless pixel stream and send
keyboard, pointer, clipboard, and file interactions back to their own remote
window. No client extension, VNC application, or replacement website UI is
required.

**Current source baseline:** 1.4.2 · Node.js 22+ · Linux amd64 · Docker Compose

## Contents

- [Features](#features)
- [Why this approach](#why-this-approach)
- [Architecture](#architecture)
- [Installation](#installation)
- [Configuration](#configuration)
- [Usage](#usage)
- [Security and compatibility](#security-and-compatibility)
- [Operations](#operations)
- [Source layout](#source-layout)
- [Development and tests](#development-and-tests)
- [Third-party notices](#third-party-notices)

## Features

| Capability | Implementation |
| --- | --- |
| Real website rendering | The original site runs in server-side Google Chrome; the client displays its rendered pixels rather than a recreated UI. |
| Independent interactions | Each client tab receives a separate remote window, viewport, focus, and input stream within one persistent browser profile. |
| Lossless display | RGB capture, QOI encoding, WebAssembly decoding, and WebSocket DEFLATE preserve captured pixels without lossy video compression. |
| Responsive resolution | The remote viewport follows client dimensions and device pixel ratio, subject to configured physical-pixel limits. |
| Familiar input | Pointer cursors, text selection, dragging, wheel input, keyboard shortcuts, and IME composition are bridged to the remote page. |
| Touchscreen input | Finger taps and swipes use server Chrome's touch gesture handling; software keyboard edits and visible-viewport changes are bridged independently of desktop mouse input. |
| Clipboard and files | Text and supported rich clipboard content, image paste, drag-and-drop upload, file selection, and downloads are bridged where the target site supports them. |
| Shared persistent state | Browser cookies, storage, and profile state persist across container replacement; users share that profile, not separate accounts. |
| Administrator login workspace | An exclusive, browser-toolbar-visible workspace supports manual sign-in using the same profile and network configuration. |
| Workload-aware capture | Changed regions are captured incrementally; unchanged frames are skipped, disconnected windows stop capture, and encoder workers are apportioned across active sessions. |
| Reconnection and flow control | Automatic client reconnect, ordered frame acknowledgements, and a bounded two-frame pipeline prevent unbounded frame queues. |
| Background resource saving | A tab hidden for one minute disconnects automatically, stops capture, and suspends its member page scripts. Returning reconnects to the same session until the normal disconnected-session retention expires. |
| Idle browser retention | A minimized blank window keeps the shared browser alive when all member sessions expire. It does not load a website, capture frames, or occupy a member slot. |
| Controlled network egress | Optional upstream browser proxy configuration centralizes outbound access on the server. |
| Containerized operation | Non-root application user, read-only container root filesystem, project-local application data, health checks, and configurable retention. |

The default capture ceiling is **60 FPS**, with a maximum physical frame size
of **8192 × 4320** and an active-session limit of **12**. These are configuration
limits, not guaranteed performance figures.

## Why this approach

- **Keep the original interface.** Existing website layout and functionality run
  in a real browser instead of being reimplemented in a separate frontend.
- **Preserve text and UI detail.** Lossless RGB transport avoids the chroma loss
  associated with common 4:2:0 video streams.
- **Simplify client access.** A compatible desktop or touchscreen browser is sufficient; clients
  do not need access to the server's upstream proxy or browser installation.
- **Centralize browser state.** One managed profile provides consistent cookies,
  installed fonts, and outbound network configuration.
- **Separate input without duplicating every profile.** Independent windows avoid
  users controlling the same desktop pointer, while sharing the browser profile.
- **Keep deployment auditable.** Source, examples, and tests are versioned; runtime
  data and credentials are kept outside Git.

Possible deployment patterns include an internal dashboard, a classroom
documentation environment, a web-based demonstration station, or an authorized
web tool that requires a controlled server network. These are architectural use
cases, not a claim that every third-party website has been integrated or tested.

## Architecture

```text
Client browser(s)
    ↕ lossless frames + keyboard / pointer / clipboard / files
Node.js gateway — session and frame-flow management
    ↕
Server Chrome — one persistent profile, independent client windows
    ↓
Target website — direct access or a configured upstream proxy
```

The capture path uses Xvfb/Openbox, XComposite, XShm, XDamage, and XFixes.
Native C/C++ helpers capture RGB pixels and provide manual-workspace input.
The client reconstructs QOI tiles using WebAssembly and draws them on a canvas.
No VNC or Chrome debugging port is published.

This is a **remote pixel browser**, not a reverse proxy that serves the original
DOM to the client and not a fully isolated, multi-tenant browser service.

## Installation

### Requirements

- A Linux **amd64** host and an **x86-64-v3-capable CPU**; the native capture helper
  is built for that instruction-set baseline.
- Docker Engine with BuildKit and Docker Compose v2.
- Sufficient CPU, memory, and bandwidth for the chosen resolution and number of
  users. The current rendering/capture path is CPU-based; a GPU is not required.
- A client browser supporting Canvas, WebSocket, and WebAssembly SIMD.
  Touchscreen clients also need Pointer Events; platform clipboard permissions
  and native file dialogs remain controlled by the client browser.
- The pinned browser installer described in [vendor/README.md](vendor/README.md).

The commands below are for a **new deployment**. An existing deployment must
retain its current `.env`, private Compose configuration, and `data/`.

### 1. Obtain the source and build assets

```sh
git clone <repository-url-or-local-path> browser-gateway
cd browser-gateway
sh scripts/prepare-vendor.sh
```

Use your actual local or remote Git source in place of the placeholder. The
repository does not configure or publish a GitHub remote automatically.

The browser helper reuses a verified installer when available. A fresh checkout
may need the exact pinned package through `CHROME_DEB_URL`; the official
`current` download can change. The helper rejects mismatched files and does not
install software on the host.

### 2. Create private configuration

```sh
cp .env.example .env
cp compose.example.yaml docker-compose.yml
openssl rand -hex 32
```

Set a strong `ADMIN_KEY` and paste the generated value into `SESSION_SECRET`.
Configure the target landing URL using `CHATGPT_URL`—a legacy variable name kept
for compatibility. The example points to a public example page and disables the
upstream proxy.

The transport supports reuse, but the current browser adapter also contains
upstream-specific startup checks and navigation-recovery policies. Review
[src/browser-manager.js](src/browser-manager.js) and the page bridges before
integrating another production website; changing the landing URL alone is not a
compatibility guarantee.

### 3. Prepare persistent storage

```sh
mkdir -p data/tmp data/home data/cache data/config
sudo chown -R 1007:1007 data
chmod 600 .env
```

The image runs as UID/GID `1007:1007`. Apply ownership to the new deployment's
`data/` directory only, not to unrelated server directories.

### 4. Build and start

```sh
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:3003/healthz
```

Open [http://127.0.0.1:3003/](http://127.0.0.1:3003/) on the deployment host after
the service becomes healthy. The example binds to loopback by default. Choose an
appropriate private-network `BIND_ADDRESS` or a protected reverse-proxy entry
point when other devices need access.

## Configuration

Configuration is read from the private `.env` and Compose environment.

| Setting | Default or example | Purpose |
| --- | --- | --- |
| `ADMIN_KEY` | Required; no safe production default | Access code for administrator pages; at least 5 characters. |
| `SESSION_SECRET` | Required | Session-cookie signing secret; at least 32 characters; keep stable across upgrades. |
| `CHATGPT_URL` | `https://example.org/` in the template | Initial target URL; legacy name, subject to adapter compatibility. |
| `UPSTREAM_PROXY` | `none` in the template | Disable proxying or provide a proxy URL reachable from the container. |
| `BIND_ADDRESS` | `127.0.0.1` | Example Compose host bind address. |
| `HOST_PORT` | `3003` | Example Compose host port; its internal gateway port remains 3003. |
| `STREAM_MAX_FPS` | `60` | Capture-rate ceiling; accepted range 30–120. |
| `STREAM_MAX_WIDTH` / `STREAM_MAX_HEIGHT` | `8192` / `4320` | Maximum physical frame dimensions, including device pixel ratio. |
| `MAX_ACTIVE_SESSIONS` | `12` | Maximum concurrent remote sessions; accepted range 1–12. |
| `SESSION_IDLE_MINUTES` | `60` | Retention of disconnected remote sessions; separate from the fixed one-minute hidden-tab disconnect. |
| `MAX_UPLOAD_MB` | `500` | Per-file upload limit; up to 10 files per request. |
| `DOWNLOAD_TTL_MINUTES` | `60` | Temporary download retention. |
| `LOG_RETENTION_DAYS` | `7` | Application-log retention. |
| `PUBLIC_HOST` | Empty in the template | Hostname or IP checked against an HTTPS certificate. |
| `ACME_ENABLED` | `false` | Enable optional certificate issuance/renewal with an externally reachable challenge listener. |
| `HTTPS_REDIRECT` | `false` | Redirect HTTP to HTTPS once a usable certificate is loaded. |
| `COOKIE_SECURE` | `false` | Optional secure-cookie requirement; HTTPS requests already receive secure cookies. |

Container-local `DATA_ROOT`, `HOME`, `TMPDIR`, and XDG directories are assigned
under the mounted application data directory by the example Compose file.
The production deployment may additionally use a private proxy sidecar; its
configuration and credentials are not part of the repository.

## Usage

### Member workspace

Open `/` in a client browser. The existing site appears in the remote canvas.
Resize the browser window normally; remote viewport and pixel ratio are updated
automatically. Each client tab has its own remote input/window session.

Use supported website interactions as usual: select and copy text, type with an
IME, paste text or images, drag files onto a compatible upload area, use a
website's file chooser, and save supported downloads locally.

Switching to another tab or hiding the browser starts a one-minute grace period.
After that, the gateway pauses its connection, capture, and member-page scripts;
returning reconnects automatically. The remote page and draft remain in memory
until `SESSION_IDLE_MINUTES` expires or capacity requires reclaiming an inactive
session; after reclamation, the last saved URL is loaded using the shared profile.
A visible tab does not disconnect merely because you stop typing.

On a touch device, tap an editable field to use the software keyboard, swipe to
scroll, or hold text to select a word and drag to extend the selection. The
visible viewport follows orientation changes and keyboard resizing. Native
file selection may require a second tap if the client browser rejects opening
the picker after the network round trip.

### Administrator workspace

- `/admin`: authenticate with `ADMIN_KEY` and open an administrator session.
- `/admin/signin`: authenticate, start the exclusive manual-login workspace,
  complete sign-in yourself, and finish to resume member sessions.
- `/healthz`: read-only service and browser readiness.

Manual login temporarily suspends member sessions. It uses the same persistent
profile and proxy, shows the server browser toolbar, and transfers actual
keyboard/pointer input without the normal page-script bridges or browser
debugging interface. Its supported interactions are narrower than member mode.

### Branding

Portal titles and layout are in `public/*.html` and `public/styles.css`.
The favicon is `public/favicon.svg`. Replace inherited branding with assets you
are authorized to use when adapting the gateway.

## Security and compatibility

- **Members do not have individual access codes or isolated accounts.** Anyone
  who can reach the member entry point can use the shared browser state.
  Protect the service with network restrictions, a VPN, or an external
  authentication layer before exposing it beyond trusted users.
- Shared cookies, website storage, and account history are not tenant-isolated.
  Independent windows separate input and viewports, not authorization or
  website-level side effects.
- Use HTTPS for credentials and sensitive content. HTTP is available, but some
  clipboard APIs require a secure context and client/browser permission.
- Existing matching certificates can be placed at `data/tls/key.pem` and
  `data/tls/fullchain.pem` with `PUBLIC_HOST` configured. Certificates are not
  generated by the example; ACME remains opt-in and requires its challenge
  port to be routed appropriately. Client certificate trust is managed by you.
- Compatibility depends on the target site. Voice, camera/microphone access,
  browser extensions, OS-level context menus, and all native browser dialogs
  are not provided as a complete local-browser equivalent.
- Lossless transport preserves captured pixels, not a different operating
  system's font rasterization. Resolution and rate limits do not guarantee
  any particular end-to-end latency or physical display refresh rate.
- Only use websites and shared accounts you are authorized to access, in
  accordance with their applicable terms.

## Operations

```sh
docker compose ps
docker compose exec app npm run check
docker compose exec app npm test
```

Application logs are written under `data/logs/`; Docker's container log driver
is disabled in the example. Uploads, temporary downloads, and application logs
have retention controls. The browser profile is persistent and is not an
ephemeral cache.

For an upgrade, keep the private configuration and rebuild the application:

```sh
docker compose build app
docker compose up -d --no-deps app
```

Back up `.env`, the private Compose/proxy configuration, and `data/`. Stop the
application before taking a consistent browser-profile backup; store archives
under the ignored `backups/` directory and protect them as credentials. Restore
the profile and the same signing secret together.

Application writes are contained by the project's data mounts. Docker images,
build cache, and engine metadata remain in the host's Docker storage and are
not relocated merely by choosing a project directory.

## Source layout

```text
.
├── README.md                  # English documentation
├── README.zh-CN.md             # 中文文档
├── Dockerfile                 # Browser runtime + native/WASM build
├── compose.example.yaml       # Portable, credential-free deployment example
├── .env.example               # Configuration template
├── src/                       # Gateway, browser/session manager, bridges, TLS
├── public/                    # Client canvas, input handling, portal assets
├── codec/                     # Native RGB capture, native input, QOI/WASM codec
├── tests/                     # Unit tests, fixtures, integration/measurement tools
├── scripts/                   # Build-asset preparation helper
├── vendor/                    # Pinned third-party source, licenses, checksums
└── THIRD_PARTY_NOTICES.md      # Attribution and distribution scope
```

`data/`, `vpn/`, `.env`, deployment-specific `docker-compose.yml`, browser
installers, certificates, logs, and generated output are intentionally ignored
by Git. The running deployment keeps its private files in place; the tracked
Compose example is not automatically applied.

## Development and tests

The built image includes the QOI WebAssembly artifact, so it is the simplest
environment for `npm run check` and `npm test`. Bare-host `npm test` also needs
the generated `public/qoi.wasm` and installed Node dependencies.

The unit suite covers lossless pixel round-trips, frame flow and stale ACKs,
pointer batching/drag state, paint readiness, transport compression, diagnostic
filtering, and favicon wiring. Integration fixtures cover viewport/DPR mapping,
IME and clipboard input, file transfer, independent windows, and administrator
login transitions.

`tests/mobile-e2e.mjs` exercises simulated phone/tablet touch input, orientation,
keyboard-sized viewports, long-press selection, and files. `tests/background-e2e.mjs`
uses normal Chrome tab visibility and waits through the actual one-minute grace
period to verify suspension, capture release, and reconnection. These are browser
simulations; device keyboards and operating-system dialogs require device-specific
acceptance where available.

Run interaction tests only against a **disposable fixture deployment with its
own profile and data directory**, not a production shared account. Performance
tools report their own workload and measurement point; they do not certify
native-browser equivalence.

Keep English and Chinese documentation synchronized, use the lockfile for
dependency changes, retain third-party notices, and review `git diff --cached`
before committing. Never commit cookies, accounts, private configuration,
captures, or runtime directories.

## Third-party notices

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md),
[codec/LICENSE](codec/LICENSE), and [vendor/README.md](vendor/README.md).
No top-level project distribution license has been selected.
