# Block (Valenced)

Standalone Block plugin. It does not include Pull and does not import Pull source files.

Use /block with id1, id2, and optional additional ID fields to watch up to 20 Discord user IDs. Use /unblock to pause protection. The Configure screen also lets you save IDs, enable or pause protection, and toggle server mute, server deafen, and disconnect independently.

Block watches the voice channel your active account is currently connected to. It detects a configured user's transition into that same channel, attempts the enabled actions once for that entry, and does not repeat requests every poll. If the user leaves and joins again, it detects the new entry and tries again. Leaving voice pauses protection; joining voice again resumes it automatically.

Block sends each enabled moderation request to Discord instead of treating the phone's cached permission check as final. Discord enforces permissions on its servers: server mute requires Mute Members, server deafen requires Deafen Members, and disconnect requires Move Members. The plugin cannot grant or bypass those permissions, so Discord will reject actions that your account is not allowed to perform. The status field and toast show Discord's HTTP rejection details when available.

Disconnect only removes the user from the current voice channel. It is not a server ban, and the user may join again.

Version 1.0.1 adds tested ID parsing, tested voice-state resolution and join/rejoin detection, and clearer request diagnostics.

Test branch: build/block-standalone-test.
