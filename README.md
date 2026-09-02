# Live Cursor for Obsidian

**Status: Early Development**

Live Cursor is currently under active development and **has not been published** to the Obsidian community plugin catalog yet. Expect bugs, missing features, and breaking changes between releases. If you find a problem, please open an issue — reports like yours are what make this project better.

Live Cursor is a lightweight real-time collaborative editing and configuration sync engine for Obsidian vaults. It brings real-time collaborative editing, live collaborator cursor tracking, and vault synchronization across devices without complex setups.

---

## What Works Today

- **Real-Time Cursor Tracking**: View the live cursors and text selections of other editors inside your notes, with custom user profiles and colors.
- **Collaborative Editing**: Open the same note on multiple devices and edit together in real time, powered by Yjs CRDTs.
- **Config Sync Engine**: Bidirectional synchronization of settings, themes, snippets, and other files in your vault. Handles conflicts by automatically merging notes (CRDT) and JSON configs (deep merge), with a last-modified-wins fallback for other files.
- **Local Host Mode (Desktop)**: One click starts a private Node.js sync server on your PC for devices on the same network (or a Tailscale/ZeroTier VPN).
- **Cloud Server Mode**: Deploy the included server on any VPS or Raspberry Pi for always-on sync.

## What's In Development

- **WebRTC P2P Mode (Mobile)**: Peer-to-peer sync without a central server is planned but not implemented yet. The README used to claim this feature — it does not exist in the code today. This is the next big piece of work.
- **Plugin Catalog Submission**: Submission to the official Obsidian community plugin catalog will happen once the plugin reaches a more stable state.
- **Admin diagnostics dashboard**: Planned for dedicated cloud instances.

---

## Connection Modes

### 1. Local Host (LAN/VPN)

**Best for:** Desktop users who want a quick, private sync session with other computers on their Wi-Fi or VPN.

- **How it works:** When you click "Start Local Server" in settings on a desktop PC, Live Cursor silently spins up a lightweight Node.js WebSocket daemon in the background. It listens on port `4444`.
- **Simplicity:** No terminals, no Docker, no configuration files. One click and your PC is the server.
- **Limitations:** Only works on desktop OS (Windows, Mac, Linux). Mobile devices (iOS/Android) cannot act as the host in this mode because mobile operating systems block background TCP port binding. Mobile devices can join a desktop host, but they cannot be the host.

### 2. Cloud Server

**Best for:** Always-on sync across the internet, 24/7, without keeping a PC running.

- **How it works:** You deploy the server (via Docker or Node) on a dedicated VPS (like DigitalOcean, AWS, or a Raspberry Pi). You then point your Live Cursor settings to that `ws://` URL.
- **Simplicity:** The repository includes a `Dockerfile`. Build and run it, set the `AUTH_TOKEN` environment variable to a strong password, and point your devices at it.
- **Limitations:** Requires a machine that is always on, and some technical knowledge (DNS, TLS, firewalls) to set up securely over the internet.

### 3. WebRTC P2P (Mobile friendly)

**Status: Not implemented yet.** Planned as a future connection mode that would let devices sync peer-to-peer without any server, ideal for mobile. Follow the repository to know when it lands.

---

## Security Notes

- The server is protected by a shared password (`AUTH_TOKEN` on the server, "Server Password" in the plugin settings). All devices must use the same password.
- The default password is `default-pass` — **change it** before connecting devices to anything other than your own localhost server.
- The local HTTP API and WebSocket connection both require the password. Connections with the wrong password are rejected.
- Traffic between devices and the server is not encrypted. For internet deployments, put the server behind TLS (e.g., a reverse proxy like Caddy or Nginx) and use `wss://` / `https://` URLs.

---

## Setup (From Source)

### 1. Install dependencies

```bash
npm install
```

This is required before building — the build tool (esbuild) is installed as a dev dependency.

### 2. Build the plugin

```bash
npm run build
```

This produces `main.js` in the plugin folder.

### 3. Install the plugin into Obsidian

Obsidian loads plugins from your vault's plugin directory:

```
<your vault>/.obsidian/plugins/live-cursor/
```

Copy these files into that directory:

- `main.js`
- `manifest.json`

(You can also copy `styles.css` if one is generated later.) Then restart Obsidian and enable "Live Cursor" in Settings -> Community Plugins.

### 4. Run the server

- **Local:** Open Settings -> Live Cursor and click "Start Local Server". Your PC is now the host on port `4444`.
- **Cloud (Docker):**

```bash
docker build -t live-cursor-server .
docker run -d -p 4444:4444 -e AUTH_TOKEN=your-strong-password -v live-cursor-data:/app/data live-cursor-server
```

### 5. Connect devices

On every device (including the host):

- **Server Connection URL**: `ws://YOUR_PC_IP:4444` (or your cloud `wss://` URL)
- **Room Name**: the exact same on all devices
- **Server Password**: the exact same on all devices

Open the same note on two devices and start typing — cursors and edits sync in real time.

---

## Architecture

Live Cursor is built on two channels:

1. **Yjs WebSocket sync** (`y-websocket` + `y-codemirror.next`) — real-time collaborative editing and cursor awareness per note.
2. **HTTP sync API** (`server.js`) — whole-vault file and configuration synchronization (manifest comparison, upload/download, CRDT conflict resolution, JSON deep merge).

The server persists Yjs room state to disk (`data/rooms/`) so documents survive restarts. The client keeps a pending-deletion queue so files deleted while offline are not resurrected after the server becomes reachable again.

---

## License

This project is licensed under the MIT License. Free, open source, for everyone.
