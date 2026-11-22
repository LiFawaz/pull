# Block (Valenced)

Standalone Block plugin. It does not include Pull and does not import Pull source files.

Use /block with id1, id2, and optional additional ID fields to watch up to 20 Discord user IDs. Use /unblock to pause protection. The Configure screen lets you save IDs, enable or pause protection, and independently toggle server mute, server deafen, and disconnect.

Block watches the voice channel your active account is currently connected to. When a configured user joins, it attempts the enabled actions. While that user remains in your channel, Block checks their server mute and server deafen state and re-applies an enabled action if they become unmuted or undeafened. Enforcement reacts to voice-state events and checks every 500ms as a backup. Successful actions are not repeated while their state update is pending; if the update is delayed, Block retries after a short verification window. Discord-provided Retry-After values are always respected. Permission failures are held until a relevant permission, role, member, or channel update occurs. Disconnect is attempted on entry, and again if the user leaves and re-enters. Leaving voice pauses protection; joining voice again resumes it automatically.

Block sends moderation requests to Discord, which enforces permissions server-side. Server mute requires Mute Members, server deafen requires Deafen Members, and disconnect requires Move Members. The plugin cannot grant or bypass permissions, role hierarchy, or server restrictions. Actions that your account cannot perform will be rejected by Discord. No action pop-up toasts are shown; status and errors remain in the Configure status area and debug logs.

Disconnect only removes the user from the current voice channel. It is not a server ban, and the user may join again.

Version 1.0.4 fixes stale pending-action state, retries disconnect while a configured user remains in the active channel, and improves recovery after permission changes.

Test branch: build/block-enforcement-config-test.
