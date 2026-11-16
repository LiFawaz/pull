# Pull

A Valenced plugin for moving only the Discord accounts you explicitly configure into your current voice channel.

## Quick commands

Pull now adds local slash commands to Discord's command picker through Coco's Command Lib.

Use `/pull` and fill `id1`, `id2`, `id3`, and so on. `id1` is required; the other fields are optional. Enter 1–20 different Discord user IDs, one per field. The command saves those IDs and starts Pull without opening plugin settings.

Use `/unpull` to stop all moves. The saved IDs remain in the plugin settings so you can reuse them later.

These are local client commands, not server-registered bot commands. They do not send a command message into the channel.

## Build on GitHub

Every push to `main` starts the **Build Pull plugin** GitHub Actions workflow. You can also start it manually from the Actions tab.

When the workflow succeeds, open its run and download the `pull-1.0.17-install-zip` artifact. Install that ZIP from Valenced > Settings > Valenced > Plugins > settings gear > Install from file.

## Configure

The plugin settings still allow you to paste Discord user IDs manually. Use one ID per line or separate them with commas. Up to 20 IDs are supported.

Join a voice channel in the server where the configured accounts are connected. Pull moves only configured accounts that are already connected to voice in that same server. If you leave voice while Pull is enabled, it stays armed and resumes automatically when you rejoin.

When you switch voice channels or reconnect after leaving voice, Pull checks again using Discord's current-client voice channel lookup and moves those configured accounts to your new channel. If a configured account disconnects and later joins voice, Pull checks it again.

## Continuous checks and retry behavior

While enabled, Pull rechecks configured accounts every 250 milliseconds and also reacts to voice and channel events. Move requests are spaced by 50 milliseconds, while Discord rate-limit handling and the existing per-account and global move limits remain in place. A target's 8-second confirmation window no longer blocks a retry after its voice state changes to a different source channel. After a move request, it waits up to 8 seconds for Discord's voice-state update before retrying. Temporary failures use backoff, and Discord rate limits are respected automatically. `/unpull` stops the loop.

## Voice state and diagnostics

Pull reads Discord's voice-state map with its guild keys intact, including object-backed and nested Map-backed store results. The status line distinguishes accounts not in voice, accounts in another server, pending confirmation, permission or role-hierarchy blocks, and the current voice channel's occupancy. Pull checks the active account's effective **Move Members** permission and **Connect** permission in the destination channel. Discord's full-channel override is based on the account performing the move, not on whether the target alt is an Administrator. If Discord rejects a move with a capacity error, Pull waits until a voice slot opens; permission failures use a longer backoff.

## Permission and safety behavior

- Pull checks the current account's effective **Move Members** permission and **Connect** permission in the destination voice channel.
- An alt must already be connected to voice in the same server. An Administrator permission on the alt does not grant your current account permission to move it.
- Discord can still reject a move because of permissions or role hierarchy; those failures are shown and retried more slowly.
- Pull does not bypass permission checks or try to move accounts from another server.
- It does not act on accounts that are not in voice.
- Only IDs explicitly entered with `/pull` or in the settings are eligible; it does not scan or move other server members.
- Per-account and global move limits prevent rapid repeat moves. A target that is moved repeatedly is temporarily paused.
- Discord may record voice moves in the server audit log.

## Source

This repository contains the source for the Pull plugin. GitHub Actions builds the installable ZIP; no local build environment is required.
