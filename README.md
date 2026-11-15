# Pull

A Valenced plugin for moving only the Discord accounts you explicitly configure into your current voice channel.

## Quick commands

Pull now adds local slash commands to Discord's command picker through Coco's Command Lib.

Use `/pull` and fill `id1`, `id2`, `id3`, and so on. `id1` is required; the other fields are optional. Enter 1–20 different Discord user IDs, one per field. The command saves those IDs and starts Pull without opening plugin settings.

Use `/unpull` to stop all moves. The saved IDs remain in the plugin settings so you can reuse them later.

These are local client commands, not server-registered bot commands. They do not send a command message into the channel.

## Build on GitHub

Every push to `main` starts the **Build Pull plugin** GitHub Actions workflow. You can also start it manually from the Actions tab.

When the workflow succeeds, open its run and download the `pull-1.0.7-install-zip` artifact. Install that ZIP from Valenced > Settings > Valenced > Plugins > settings gear > Install from file.

## Configure

The plugin settings still allow you to paste Discord user IDs manually. Use one ID per line or separate them with commas. Up to 20 IDs are supported.

Join a voice channel in the server where the configured accounts are connected. Pull moves only configured accounts that are already connected to voice in that same server.

When you switch voice channels, Pull checks again and moves those configured accounts to your new channel. If a configured account disconnects and later joins voice, Pull checks it again.

## Continuous checks and retry behavior

While enabled, Pull rechecks configured accounts every 750 milliseconds and also reacts to voice and channel events. Move requests are spaced by 350 milliseconds, while the existing per-account and global rate limits remain in place. After a move request, it waits up to 3.5 seconds for Discord's voice-state update before retrying. Temporary failures use backoff, and Discord rate limits are respected automatically. `/unpull` stops the loop.

## Voice state and diagnostics

Pull reads Discord's voice-state map with its guild keys intact. The status line distinguishes accounts not in voice, accounts in another server, pending confirmation, permission or role-hierarchy blocks, and accounts waiting for a free voice slot. When a channel has a user limit, Pull counts its current voice members and checks each target account's effective channel permissions. Accounts with Administrator or Move Members can be tried in a full channel; accounts without either wait until a slot is available. Permission lookup is cached briefly and refreshed after channel or member-role updates.

## Permission and safety behavior

- Pull checks the current account's effective **Move Members** permission in both the source and destination voice channels.
- It does not bypass permission checks or try to move accounts from another server.
- Accounts that Discord rejects with a permission error are retried more slowly; the rejection may be caused by missing permissions or role hierarchy.
- It does not act on accounts that are not in voice.
- Only IDs explicitly entered with `/pull` or in the settings are eligible; it does not scan or move other server members.
- Per-account and global move limits prevent rapid repeat moves. A target that is moved repeatedly is temporarily paused.
- Discord may record voice moves in the server audit log.

## Source

This repository contains the source for the Pull plugin. GitHub Actions builds the installable ZIP; no local build environment is required.
