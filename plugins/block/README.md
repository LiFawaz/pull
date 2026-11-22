# Block (Valenced)

Standalone Block plugin. It does not include Pull and does not import Pull source files.

Use /block with id1, id2, and optional additional ID fields to watch up to 20 Discord user IDs. Use /unblock to pause protection. The Configure screen lets you save IDs, enable or pause protection, and independently toggle server mute, server deafen, and disconnect.

Block watches the voice channel your active account is currently connected to. When a configured user joins, it attempts the enabled actions. While that user remains in your channel, Block checks their server mute and server deafen state and re-applies an enabled action if they become unmuted or undeafened. Enforcement reacts to voice-state events and checks every 500ms as a backup. Successful actions are not repeated while their state update is pending; if the update is delayed, Block retries after a short verification window. Discord-provided Retry-After values are always respected. Permission failures are held until a relevant permission, role, member, or channel update occurs. Disconnect is retried while the configured user remains in your active voice channel, subject to Discord's own rate limits and permission checks. If they rejoin after being disconnected, Block detects the new entry and tries again. Leaving voice pauses protection; joining voice again resumes it automatically.

Block sends moderation requests to Discord, which enforces permissions server-side. Your account needs Mute Members for server mute, Deafen Members for server deafen, and Move Members for disconnect. The target user's own mute/deafen permissions do not grant your account those permissions. The plugin cannot grant or bypass permissions, role hierarchy, or server restrictions. Actions that your account cannot perform will be rejected by Discord. No action pop-up toasts are shown; status and errors remain in the Configure status area and debug logs.

Disconnect only removes the user from the current voice channel. It is not a server ban, and the user may join again.

Version 1.0.5 adds a phone-call plugin icon and fixes active voice-state lookup when Valenced exposes guild voice states as nested Maps. It also includes clearer test coverage for that lookup.

After installing an update, use Valenced's Reload now option or restart Discord so the updated plugin code and icon are loaded.

Test branch: build/block-enforcement-config-test.
