import { describe, expect, test } from 'bun:test'
import {
    DEAFEN_MEMBERS,
    MUTE_MEMBERS,
    MOVE_MEMBERS,
    getDiscordErrorMessage,
    getNewVoiceEntrants,
    hasPermission,
    parseCommandIds,
    parseTargetIds,
    resolveCurrentVoiceInfo,
    resolveUserVoiceInfo,
} from './helpers'

describe('Block ID parsing', () => {
    test('parses newline, spaces, commas and semicolons and removes duplicates', () => {
        expect(parseTargetIds(
            '123456789012345, 234567890123456;123456789012345\n345678901234567',
            20,
        )).toEqual({
            ids: ['123456789012345', '234567890123456', '345678901234567'],
            overflow: false,
            invalid: [],
        })
    })

    test('rejects malformed values instead of silently arming with them', () => {
        expect(parseTargetIds('not-an-id 1234 -123456789012345', 20)).toEqual({
            ids: [],
            overflow: false,
            invalid: ['not-an-id', '1234', '-123456789012345'],
        })
    })

    test('enforces the configured target limit after de-duplication', () => {
        expect(parseTargetIds(
            '123456789012345 234567890123456 345678901234567',
            2,
        )).toEqual({
            ids: ['123456789012345', '234567890123456'],
            overflow: true,
            invalid: [],
        })
    })

    test('parses slash command option objects', () => {
        expect(parseCommandIds([
            { name: 'id1', value: '123456789012345' },
            { name: 'id2', value: '234567890123456' },
            { name: 'other', value: 'invalid' },
        ], 20)).toEqual({
            ids: ['123456789012345', '234567890123456'],
            error: null,
        })
    })

    test('rejects invalid slash command options and empty commands', () => {
        expect(parseCommandIds([{ name: 'id1', value: 'not-an-id' }], 20).error)
            .toContain('numeric Discord user ID')
        expect(parseCommandIds([], 20).error)
            .toContain('at least one ID')
    })
})

describe('Block voice-state resolution', () => {
    test('uses current client voice channel even if cached own state is stale', () => {
        const userId = '123456789012345'
        const channel = { id: 'voice-live' }
        const voiceStore = {
            getAllVoiceStates: () => ({ 'guild-a': { [userId]: { channelId: null } } }),
            getVoiceState: () => ({ channelId: null }),
            getCurrentClientVoiceChannelId: () => 'voice-live',
        }

        expect(resolveCurrentVoiceInfo(userId, voiceStore, {
            getChannel: (id: string) => id === 'voice-live' ? channel : null,
        })).toEqual({
            channelId: 'voice-live',
            guildId: 'guild-a',
            channel,
        })
    })

    test('finds a configured user in the selected guild', () => {
        const channel = { id: 'voice-a', guildId: 'guild-a' }
        const userId = '234567890123456'
        const voiceStore = {
            getVoiceState: (guildId: string, id: string) =>
                guildId === 'guild-a' && id === userId
                    ? { channelId: 'voice-a' }
                    : undefined,
        }

        expect(resolveUserVoiceInfo(userId, 'guild-a', voiceStore, {
            getChannel: () => channel,
        })).toEqual({
            channelId: 'voice-a',
            guildId: 'guild-a',
            channel,
        })
    })

    test('supports Map-backed voice states', () => {
        const userId = '234567890123456'
        const all = new Map([
            ['guild-a', new Map([[userId, { channelId: 'voice-a' }]])],
        ])
        expect(resolveUserVoiceInfo(userId, 'guild-a', {
            getAllVoiceStates: () => all,
        }, {})).toEqual({
            channelId: 'voice-a',
            guildId: 'guild-a',
            channel: null,
        })
    })

    test('returns disconnected when own user has no current voice state', () => {
        expect(resolveCurrentVoiceInfo('123456789012345', {
            getAllVoiceStates: () => ({
                'guild-a': { '123456789012345': { channelId: null } },
            }),
            getCurrentClientVoiceChannelId: () => undefined,
            getUserVoiceChannelId: () => undefined,
            getVoiceStateForUser: () => ({ channelId: null, guildId: 'guild-a' }),
        }, {})).toEqual({
            channelId: null,
            guildId: null,
            channel: null,
        })
    })
})

describe('Block join detection and permissions', () => {
    test('fires once on entry, not every poll, then again after leave and rejoin', () => {
        const id = '234567890123456'
        const presence = new Map<string, boolean>()
        let targetChannelId: string | null = null
        const resolve = () => ({
            channelId: targetChannelId,
            guildId: targetChannelId ? 'guild-a' : null,
            channel: null,
        })

        expect(getNewVoiceEntrants([id], 'guild-a', 'voice-a', presence, resolve)).toEqual([])
        targetChannelId = 'voice-a'
        expect(getNewVoiceEntrants([id], 'guild-a', 'voice-a', presence, resolve)).toEqual([id])
        expect(getNewVoiceEntrants([id], 'guild-a', 'voice-a', presence, resolve)).toEqual([])
        targetChannelId = null
        expect(getNewVoiceEntrants([id], 'guild-a', 'voice-a', presence, resolve)).toEqual([])
        targetChannelId = 'voice-a'
        expect(getNewVoiceEntrants([id], 'guild-a', 'voice-a', presence, resolve)).toEqual([id])
    })

    test('checks mute, deafen and move permissions as separate bits', () => {
        const allowed = new Set([MUTE_MEMBERS.toString(), MOVE_MEMBERS.toString()])
        const store = {
            can(permission: bigint) {
                return allowed.has(permission.toString())
            },
        }

        expect(hasPermission(store, MUTE_MEMBERS, {})).toBe(true)
        expect(hasPermission(store, DEAFEN_MEMBERS, {})).toBe(false)
        expect(hasPermission(store, MOVE_MEMBERS, {})).toBe(true)
        expect(hasPermission(null, MOVE_MEMBERS, {})).toBe(false)
    })

    test('extracts useful Discord rejection details', () => {
        expect(getDiscordErrorMessage({
            status: 403,
            body: { code: 50013, message: 'Missing Permissions' },
        })).toBe('HTTP 403; Discord code 50013; Missing Permissions')
    })
})
