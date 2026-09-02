# Release Notes - Version 1.3.18

This release is all about making Live Cursor safer to use and more honest about where it stands. Thanks to everyone who opened issues and sent reports — especially the build error report, which pushed me to clean up the setup guide.

## Security

The server now actually protects your data. Every request — both the real-time sync connection and the file API — has to present the shared password (`AUTH_TOKEN` on the server, "Server Password" in the plugin settings). Wrong password, no access. No more vault being readable by anyone on the network.

If you host your own server, set a strong `AUTH_TOKEN` (the default is still `default-pass`, so please change it before connecting anything outside your own machine).

## Reliability

- **Deleted files stay deleted.** If you delete a note while your phone is offline, it won't get resurrected when the server comes back. Deletions are queued and retried until the server confirms.
- **Uploads no longer destroy document history.** A full vault sync used to wipe the CRDT state of a note (delete everything, re-insert), which broke concurrent editing and made cursors jump. Now it merges cleanly, preserving history.
- **"Reconstruct Database" is scoped to your workspace.** Previously it nuked every room on the server; now it only clears the room you're syncing.
- **Room state files can no longer collide.** Long paths used to be truncated to 100 characters for filenames, which could silently mix up two notes. Files are now stored under hashed names.
- **Settings changes take effect immediately.** Changing the room name, server URL, or password now reconnects automatically instead of silently doing nothing until you find the Reconnect button.
- **Conflict merging doesn't duplicate text anymore.** Merging "hello" and "hello world" used to produce "hellohello world".
- Fixed a subtle split-brain bug where the WebSocket sync and the file API could hold two different copies of the same document, which caused phantom conflicts.

## Housekeeping

- The plugin builds cleanly (the earlier `npm install` step is now documented — esbuild is a dev dependency).
- The README now tells the truth: WebRTC mode is planned, not implemented, and the plugin is not yet in the Obsidian community catalog. It will get there.
- Removed dead code, cleaned up package metadata, removed all emoji from the UI and docs.

Happy collaborating!
