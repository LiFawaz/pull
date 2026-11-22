# Block (Valenced)

Standalone Block plugin. It does not include Pull and does not import Pull source files.

Use /block with id1, id2, and optional additional ID fields to watch up to 20 Discord user IDs. Use /unblock to pause protection. The Configure screen lets you save IDs, enable or pause protection, and independently toggle server mute, server deafen, and disconnect.

Block watches the voice channel your active account is currently connected to. When a configured user joins, it attempts the enabled actions. While that user remains in your channel, Block checks their server mute and server deafen state and re-applies an enabled action if they become unmuted or undeafened. Enforcement is event-driven with a short retry cooldown; it does not continuously spam requests. Disconnect is attempted on entry, and again if the user leaves and re-enters. Leaving voice pauses protection; joining voice again resumes it automatically.

Block sends moderation requests to Discord, which enforces permissions server-side. Server mute requires Mute Members, server deafen requires Deafen Members, and disconnect requires Move Members. The plugin cannot grant or bypass permissions, role hierarchy, or server restrictions. Actions that your account cannot perform will be rejected by Discord. No action pop-up toasts are shown; status and errors remain in the Configure status area and debug logs.

Disconnect only removes the user from the current voice channel. It is not a server ban, and the user may join again.

Version 1.0.2 adds persistent re-mute/re-deafen enforcement, rate-limited retries, silent action handling, and a redesigned Configure section.

Test branch: build/block-enforcement-config-test.
