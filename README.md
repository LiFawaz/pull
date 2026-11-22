# Pull + Block (Valenced)

A combined Valenced plugin with the existing Pull workflow and a new permission-aware Block voice-session protector.

## Local slash commands

Use `/pull` with `id1`, `id2`, and so on to move selected accounts into your current voice channel. Use `/unpull` to stop Pull.

Use `/block` with `id1`, `id2`, and so on to save up to 20 user IDs and enable Block. Use `/unblock` to pause Block without deleting the saved IDs. These commands are local client commands provided through Coco's Command Lib; they are not bot commands sent to a server.

## Block behavior

Block watches only the voice channel your active account is currently connected to, across whichever server that channel belongs to. When a configured user enters that same channel, Block checks server mute, server deafen, and voice disconnect permissions independently and attempts every enabled action your account is permitted to perform.

When you leave voice, Block pauses its active session. It automatically resumes when you join another voice channel. It only acts on user IDs you explicitly configure. It does not ban users from a server or create a permanent voice-only ban. A voice disconnect can be followed by the user rejoining, and Discord can reject actions due to missing permissions or role hierarchy.

The Block section in plugin settings lets you save IDs, enable or pause protection, and independently toggle server mute, server deafen, and voice disconnect. Status feedback appears in the same section and through a toast when an action is attempted.

## Existing Pull behavior

Pull continues to move only configured accounts already connected to voice in the same server. It checks the active account's effective Move Members and destination Connect permissions, waits for available channel capacity, and confirms moves through Discord voice state. `/unpull` stops Pull.

## Install

In Valenced, open Settings > Valenced > Plugins > the settings gear > Install from file, then select the install ZIP produced by the GitHub Actions **test build**. The ZIP has the Valenced-required `manifest.json` and `index.js` files at its root.

## Source and build

This test is built on `build/pull-plus-block-test`. It does not publish to the main branch or repository index. GitHub Actions runs the helper tests, builds the plugin, packages the install ZIP, and verifies the ZIP structure.

The test branch is isolated; the repository main branch remains unchanged.
