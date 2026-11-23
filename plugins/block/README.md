# Block

Block is a native Valenced Android plugin for managing selected user IDs in the voice channel you are currently connected to.

## Behavior

- Stores up to 20 unique Discord user IDs.
- Detects configured users who are already in your channel and users who join later.
- Watches the current voice channel only. Switching channels updates the target channel; leaving voice pauses enforcement and joining voice resumes it.
- Server Mute, Server Deafen, and Disconnect are independent settings.
- Reconciles actual voice state so an unmuted or undeafened target is detected again.
- Checks Mute Members, Deafen Members, and Move Members separately before each corresponding request.
- Waits for UserStore, VoiceStateStore, ChannelStore, PermissionStore, and Discord's HTTP module.
- Uses the authenticated Discord HTTP module and handles permission failures and Retry-After responses.
- Does not treat a successful HTTP response as proof of completion; it waits for the resulting voice state.

## Commands

- `/block`: add IDs and enable Block.
- `/unblock`: pause Block while preserving IDs and settings.

## Build

```sh
bun install
bun test plugins/block/js/helpers.test.ts
bun --bun run build --plugins-dir plugins block
python scripts/package_plugin.py block
python scripts/check_zip.py block
```

The test suite covers ID validation, object- and Map-backed voice-state lookup, permission-bit separation, retry-after parsing, Discord error extraction, and independent action planning.

Live Discord behavior still requires validation in a test server with the relevant permissions. Discord role hierarchy, server-side permissions, and API rate limits remain authoritative.
