# Block — Valenced Voice Monitor

Block is a standalone Valenced plugin for Android. It monitors the current account's active voice channel for up to 20 configured Discord user IDs and displays their voice states and local permission information inside Configure.

## Important behavior

This release is a **monitor-only** implementation. It does not send mute, deafen, or disconnect HTTP requests, and it does not silently change another account's voice state. Use Discord's native voice-channel moderation controls when an action is appropriate and authorized.

The three switches are independent display filters:

- **Track server mute** shows the target's server mute state and whether the local PermissionStore reports Mute Members.
- **Track server deafen** shows the target's server deafen state and whether the local PermissionStore reports Deafen Members.
- **Track disconnect eligibility** shows whether the local PermissionStore reports Move Members.

PermissionStore results are diagnostic only. Discord is authoritative and may still reject a moderation action because of role hierarchy, channel overwrites, server restrictions, or current state.

## Commands

`/block id1: ... id2: ...` saves the supplied IDs and enables monitoring. Up to 20 IDs are supported. IDs must be numeric Discord user IDs (15–22 digits); duplicates are removed.

`/unblock` pauses monitoring while keeping the saved IDs and settings.

The Configure screen also supports editing IDs, enabling or pausing the monitor, and changing the three independent state-display switches. Invalid IDs are rejected instead of being silently ignored.

## Monitoring behavior

Block waits for UserStore, VoiceStateStore, ChannelStore, and PermissionStore to become available. It then resolves the current account's voice channel and checks the configured IDs against voice states in that same guild and channel.

It detects users who were already present when monitoring starts, users who join later, users who leave, and users who rejoin. Voice-state and relevant guild/channel events trigger a fresh check. A one-second fallback poll covers missed events. Leaving voice pauses monitoring; joining voice again resumes it without requiring another command.

Voice states are read through the existing helper layer, including object-backed and nested Map-backed store shapes. The monitor does not infer that an HTTP request succeeded because it makes no moderation requests.

## Permissions

The monitor reads the local PermissionStore for Mute Members, Deafen Members, and Move Members when the corresponding display switch is enabled. These readings are not a guarantee that Discord will accept a future action. Discord's server-side permission and role-hierarchy checks remain decisive.

## Installation

1. Build the plugin using the repository workflow below.
2. Install the generated `com.lifawaz.block@1.1.0.zip` in Valenced.
3. Reload Valenced or restart Discord so the new plugin code and manifest icon are loaded.
4. Open Block → Configure, add IDs, and enable the monitor.

The manifest retains the plugin's custom phone-call SVG icon as an embedded data URI.

## Build and tests

From the repository root:

```sh
bun install
bun test plugins/block/js/helpers.test.ts
bun --bun run build --plugins-dir plugins block
python scripts/package_plugin.py block
python scripts/check_zip.py block
```

The GitHub Actions workflow `.github/workflows/block-test-build.yml` performs these steps on pushes to `build/block-enforcement-config-test` and uploads the standalone Block ZIP.

## Troubleshooting

- **Waiting for Discord UserStore:** the current account is not available yet. Reload Discord and check that the plugin starts.
- **Waiting for Discord VoiceStateStore:** voice state data is not ready yet.
- **Waiting for Discord ChannelStore:** the current channel cannot yet be resolved.
- **Waiting for Discord PermissionStore:** permission diagnostics are unavailable until the store loads.
- **Waiting for you to join a voice channel:** connect to a voice channel; monitoring resumes automatically.
- **No targets detected:** verify the IDs and confirm that the accounts are in the same guild and voice channel as the current account.
- **ZIP rejected:** use the ZIP emitted by `scripts/package_plugin.py`, not the GitHub Actions artifact wrapper ZIP. Validate it with `scripts/check_zip.py`.

## Development scope and handoff requirements

The original Block handoff called for a native Valenced Android plugin in its own directory, support for up to 20 IDs, `/block` and `/unblock`, a mobile-friendly Configure screen, three independent mute/deafen/disconnect settings, detection of users already in voice and users joining later, automatic pause/resume with the current account's voice session, object-backed and nested Map-backed voice-state support, explicit store readiness, useful status text, debug logs, a phone-call icon, helper tests, a standalone ZIP, and documentation.

This monitor release retains the project layout, ID management, commands, settings screen, store readiness, voice-state detection, Map/object helper support, status diagnostics, phone-call icon, tests, standalone packaging, and branch-specific build workflow.

The requested persistent automatic mute/deafen/disconnect loop is intentionally not included. This build does not repeatedly apply moderation actions to configured users. No live Discord behavior is claimed as tested by the unit-test workflow.
