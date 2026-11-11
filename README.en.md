# isend.tech

**Send files, photos and text between devices — in the browser, without an app or an account.**

[Try isend.tech](https://isend.tech) · [Русский](README.md) · [Deployment](docs/DEPLOYMENT.md) · [Architecture and limitations](docs/ARCHITECTURE.md)

Open the website on your phone and computer, select a device and send a file. Drag and drop, paste a file with **Cmd+V / Ctrl+V**, send text, or take a photo on a phone. Clipboard and camera support depend on the browser.

The project is based in Russia and the public service is hosted in Russia. You can deploy your own instance elsewhere.

## Features

- **Automatic discovery** for browsers sharing a public egress IP. When a VPN or separate networks prevent discovery, use a four-digit code with approval on the other device. Codes expire after two minutes and attempts are rate limited.
- **Remembered browsers** discover each other across networks, including VPNs, after pairing. Clearing browser data resets that browser's identity.
- **Preconnected devices**: a selected peer starts connecting before a file is chosen. Two visible devices are selected automatically; with more peers, the initial selection is alphabetical.
- **Automatic routing**: direct WebRTC where possible, or a configured TURN relay when needed. A small status label shows the route and transfer speed.
- **No server-side file storage**: TURN forwards encrypted traffic; the application server handles discovery and signaling.
- **SHA-256 block verification and reconnect/resume**, subject to the receiving storage mode.
- **Large files saved to a user-selected disk file** in supported desktop browsers, avoiding the site's browser-storage quota.
- **Text transfer in both directions**, device labels, mobile photo capture and a screen wake lock during transfers where supported.
- **Russian and English UI**, transfer diagnostics and server-side reporting tools.

## Why this workflow

Unlike installed tools such as LocalSend, starting requires only a website. Unlike sending yourself a message, it does not require signing into a messenger on the other computer. Short pairing, remembered browsers, preconnection, text transfer and disk saving reduce repeated setup.

WebRTC, TURN and browser-based transfers are not unique to this project. This is not a claim that isend is faster or more reliable than every alternative: performance depends on the network and browsers.

## Run locally

Requires Node.js **22.13+** (24 LTS recommended) and npm.

```sh
git clone https://github.com/alexdv124/isend.tech.git
cd isend.tech
npm ci
npm run typecheck
npm run build
npm test
npm start
```

Open `http://127.0.0.1:8788`. To test on one computer, use **two separate browser profiles**, such as a regular and private window. Tabs in the same profile share an identity and are not separate devices.

The server binds to loopback only. Other devices need an HTTPS reverse proxy: see [VPS and TURN setup](docs/DEPLOYMENT.md). Without TURN, connections between some networks will fail. Restart the server after rebuilding because static assets are loaded at startup.

## Large files and recovery

| Receiver mode | Data location | Limits |
|---|---|---|
| Site storage (OPFS) | On the receiving device, managed by the browser | Subject to browser quota; checkpoints persist in site storage |
| User-selected disk file | Through the system save dialog | Requires `showSaveFilePicker`, typically desktop Chrome/Edge; reconnect checkpoints live in the open tab |

Supported browsers offer a save dialog automatically for files of **512 MiB or more**, or when site quota is insufficient. Users can enable it for every file. Wait for completion and stream closure. Closing or reloading the receiving tab abandons unfinished direct-file writes; restart that transfer. Resuming also requires the sender to retain access to the source file.

There is no promise of unlimited size in every browser. Disk capacity, file-system limits, browser APIs and background suspension still apply. Direct-to-file saving is not available in every mobile browser. See [architecture](docs/ARCHITECTURE.md).

## Privacy

File and text contents use encrypted WebRTC transport rather than an application HTTP upload store. The server sees connection metadata. When diagnostics are enabled, it stores filtered technical events, byte counts, speeds and error categories, not file names or content. Remembered pairing records can also persist on the server.

This is not an anonymity network. Web servers, STUN/TURN services and network providers can observe connection addresses. Users trust the JavaScript delivered by the site. No independent security audit has been performed. See [operations and privacy](docs/OPERATIONS.md).

## Repository layout

- `app/`: React UI; `lib/`: transport, disk storage, text sharing, discovery and diagnostics.
- `server.mjs` and adjacent `.mjs` modules: HTTP server, signaling, pairing, journals and analytics.
- `public/storage-worker.js`: OPFS worker.
- `tests/`: protocol, storage, server, pairing and analytics checks.
- `scripts/`: builds and operator reports; `deploy/`: VPS and TURN configuration examples.

This is client revision 28. `/healthz` reports the independent backend revision. SSH keys, credentials, production configuration, user journals and installed dependencies are excluded.

## Validation and contributing

CI runs a clean dependency install, TypeScript checks, tests and a production build. Tests cover writing, cancellation and large-offset recovery; a simulated large-file test is not equivalent to transferring a multi-gigabyte file on a physical device.

Bug reports should include browsers, page revisions, route, transfer direction and redacted transfer statistics. Do not attach private files, pairing links, keys or raw journals. Known limitations are listed in [architecture](docs/ARCHITECTURE.md).

No source-code license has been selected yet. Public availability alone does not grant a license to redistribute derivative products.
