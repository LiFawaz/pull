# Pull

A private Valenced plugin for moving only the Discord accounts you explicitly configure into your current voice channel.

## Build on GitHub

Every push to `main` starts the **Build Pull plugin** GitHub Actions workflow. You can also start it manually from the Actions tab.

When the workflow succeeds, open its run and download the `pull-1.0.0-install-zip` artifact. Install that ZIP from Valenced > Settings > Valenced > Plugins > settings gear > Install from file.

## Configure

Open Pull's plugin settings and paste the Discord user IDs you want to move. Use one ID per line or separate them with commas. The current version accepts up to 20 IDs.

Press **Start Pull** to arm it. Join a voice channel in the server where the configured accounts are connected. Pull moves only configured accounts that are already connected to voice in that same server.

When you switch voice channels, Pull checks again and moves those configured accounts to your new channel. If a configured account disconnects and later joins voice, Pull checks it again.

Press **Stop Pull** to stop all automatic moves.

## Permission and safety behavior

- Pull checks the current account's effective **Move Members** permission in both the source and destination voice channels.
- Pull also checks **Connect** in the destination channel.
- It does not bypass permission checks or try to move accounts from another server.
- It does not act on accounts that are not in voice.
- Only IDs explicitly entered in the settings are eligible; it does not scan or move other server members.
- Per-account and global move limits prevent rapid repeat moves. A target that is moved repeatedly is temporarily paused.
- Discord may record voice moves in the server audit log.

## Source

This repository contains the source for the Pull plugin. GitHub Actions builds the installable ZIP; no local build environment is required.
