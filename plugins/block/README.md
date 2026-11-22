# Block (Valenced)

Standalone Valenced plugin. It does not include Pull.

Use `/block` with `id1`, `id2`, and optional additional ID fields to enable protection for up to 20 Discord user IDs. Use `/unblock` to pause protection. Configure also provides an ID editor and independent switches for server mute, server deafen, and voice disconnect.

Block watches only the voice channel your active account is currently connected to, across servers. It pauses when you leave voice and resumes when you join another voice channel. It attempts each enabled moderation action only when the corresponding Discord permission is available.

Server mute requires Mute Members, server deafen requires Deafen Members, and disconnect requires Move Members. Discord can still reject an action because of role hierarchy or server rules. Disconnect is not a permanent ban and does not prevent the user from joining again.

This test build is on branch `build/block-standalone-test`. It does not alter main.

Standalone source: `plugins/block/js/index.tsx`. No Pull source or runtime dependency is bundled.
