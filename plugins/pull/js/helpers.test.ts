import { describe, expect, test } from 'bun:test'
import {
    CONNECT,
    MOVE_MEMBERS,
    canMoveBetween,
    getMovePermissionIssue,
    checkCapacityWait,
    capacityWaitKey,
    createSettingsActions,
    getResponseBody,
    getRetryAfterMs,
    getVoiceChannelCapacity,
    isCapacityError,
    parseTargetIds,
    prioritizeWaitingTargets,
    getReconcileDelayMs,
    getGuildVoiceStates,
    resolveCurrentVoiceInfo,
    resolveUserVoiceInfo,
} from './helpers'

describe('Pull helper logic', () => {
    test('parses unique numeric IDs and reports overflow', () => {
        expect(parseTargetIds('123456789012345, 123456789012345; 234567890123456', 2)).toEqual({
            ids: ['123456789012345', '234567890123456'],
            overflow: false,
        })
        expect(parseTargetIds('123456789012345 234567890123456 345678901234567', 2)).toEqual({
            ids: ['123456789012345', '234567890123456'],
            overflow: true,
        })
    })

    test('accepts all 20 supported target IDs and reports only the 21st as overflow', () => {
        const ids = Array.from({ length: 20 }, (_, index) => String(123456789012345 + index))
        expect(parseTargetIds(ids.join('\n'), 20)).toEqual({ ids, overflow: false })
        expect(parseTargetIds([...ids, '223456789012345'].join('\n'), 20)).toEqual({
            ids,
            overflow: true,
        })
    })

    test('rejects malformed IDs', () => {
        expect(parseTargetIds('abc 1234 -123456789012345', 20)).toEqual({
            ids: [],
            overflow: false,
        })
    })

    test('checks Move Members and Connect only against the destination channel', () => {
        const destination = { id: 'destination' }
        const calls: Array<{ permission: bigint; channel: { id: string } }> = []
        const granted = new Set([
            MOVE_MEMBERS.toString() + ':destination',
            CONNECT.toString() + ':destination',
        ])
        const store = {
            can(permission: bigint, channel: { id: string }) {
                calls.push({ permission, channel })
                return granted.has(permission.toString() + ':' + channel.id)
            },
        }
        expect(canMoveBetween(store, destination)).toBe(true)
        expect(calls).toHaveLength(2)
        expect(calls.every(call => call.channel === destination)).toBe(true)
        expect(getMovePermissionIssue(store, destination)).toBeNull()

        granted.delete(CONNECT.toString() + ':destination')
        expect(getMovePermissionIssue(store, destination)).toBe('Connect')
        expect(canMoveBetween(store, destination)).toBe(false)
        granted.add(CONNECT.toString() + ':destination')
        granted.delete(MOVE_MEMBERS.toString() + ':destination')
        expect(getMovePermissionIssue(store, destination)).toBe('Move Members')
        expect(canMoveBetween(store, destination)).toBe(false)
    })

    test('accepts truthy permission-store results', () => {
        const destination = { id: 'destination' }
        const store = { can: () => 1 }
        expect(getMovePermissionIssue(store, destination)).toBeNull()
    })

    test('uses Discord current-client voice lookup even when cached own state is empty', () => {
        const userId = '123456789012345'
        const channel = { id: 'voice-live' }
        const store = {
            getAllVoiceStates: () => ({ 'guild-a': { [userId]: { channelId: null } } }),
            getVoiceState: () => ({ channelId: null }),
            getCurrentClientVoiceChannelId: () => 'voice-live',
            getUserVoiceChannelId: () => undefined,
        }
        expect(resolveCurrentVoiceInfo(userId, store, {
            getChannel: (id: string) => id === 'voice-live' ? channel : null,
        })).toEqual({
            channelId: 'voice-live',
            guildId: 'guild-a',
            channel,
        })
    })

    test('waits while disconnected and resumes after Discord reports a new voice state', () => {
        const userId = '123456789012345'
        const disconnectedStore = {
            getAllVoiceStates: () => ({ 'guild-a': { [userId]: { channelId: null } } }),
            getVoiceState: () => ({ channelId: null }),
            getCurrentClientVoiceChannelId: () => undefined,
            getUserVoiceChannelId: () => undefined,
            getVoiceStateForUser: () => ({ channelId: null, guildId: 'guild-a' }),
        }
        expect(resolveCurrentVoiceInfo(userId, disconnectedStore, {})).toEqual({
            channelId: null,
            guildId: null,
            channel: null,
        })

        const channel = { id: 'voice-b' }
        const connectedStore = {
            getAllVoiceStates: () => ({ 'guild-a': { [userId]: { channelId: 'voice-b' } } }),
            getCurrentClientVoiceChannelId: () => undefined,
            getUserVoiceChannelId: (guildId: string, id: string) =>
                guildId === 'guild-a' && id === userId ? 'voice-b' : undefined,
        }
        expect(resolveCurrentVoiceInfo(userId, connectedStore, {
            getChannel: (id: string) => id === 'voice-b' ? channel : null,
        })).toEqual({
            channelId: 'voice-b',
            guildId: 'guild-a',
            channel,
        })
    })

    test('falls back to official per-user voice state when guild enumeration is unavailable', () => {
        const channel = { id: 'voice-c' }
        const store = {
            getAllVoiceStates: () => { throw new Error('unavailable') },
            getVoiceStateForUser: () => ({ channelId: 'voice-c', guildId: 'guild-c' }),
        }
        expect(resolveCurrentVoiceInfo('123456789012345', store, {
            getChannel: (id: string) => id === 'voice-c' ? channel : null,
        })).toEqual({
            channelId: 'voice-c',
            guildId: 'guild-c',
            channel,
        })
    })

    test('resolves target voice states from nested Maps in the preferred guild', () => {
        const userId = '123456789012345'
        const channel = { id: 'voice-home' }
        const allVoiceStates = new Map([
            ['guild-other', new Map([[userId, { channelId: 'voice-other', guildId: 'guild-other' }]])],
            ['guild-home', new Map([[userId, { channelId: 'voice-home', guildId: 'guild-home' }]])],
        ])
        const voiceStore = {
            getAllVoiceStates: () => allVoiceStates,
        }

        expect(getGuildVoiceStates(allVoiceStates, 'guild-home')).toBe(allVoiceStates.get('guild-home'))
        expect(resolveUserVoiceInfo(userId, 'guild-home', voiceStore, {
            getChannel: (id: string) => id === 'voice-home' ? channel : null,
        })).toEqual({
            channelId: 'voice-home',
            guildId: 'guild-home',
            channel,
        })
    })

    test('supports Map-backed per-guild lookups and preserves foreign-server detection', () => {
        const userId = '123456789012345'
        const channel = { id: 'voice-target' }
        const voiceStore = {
            getVoiceStates: (guildId: string) => guildId === 'guild-home'
                ? new Map([[userId, { channelId: 'voice-target' }]])
                : undefined,
        }

        expect(resolveUserVoiceInfo(userId, 'guild-home', voiceStore, {
            getChannel: (id: string) => id === 'voice-target' ? channel : null,
        })).toEqual({
            channelId: 'voice-target',
            guildId: 'guild-home',
            channel,
        })

        const elsewhere = resolveUserVoiceInfo(userId, 'guild-home', {
            getAllVoiceStates: () => new Map([
                ['guild-other', new Map([[userId, { channelId: 'voice-other' }]])],
            ]),
        }, {})
        expect(elsewhere).toEqual({
            channelId: 'voice-other',
            guildId: 'guild-other',
            channel: null,
        })
    })

    test('reads current-client voice state from nested guild Maps', () => {
        const userId = '123456789012345'
        const channel = { id: 'voice-current' }
        const voiceStore = {
            getAllVoiceStates: () => new Map([
                ['guild-current', new Map([[userId, { channelId: 'voice-current' }]])],
            ]),
            getCurrentClientVoiceChannelId: () => undefined,
            getUserVoiceChannelId: () => undefined,
        }
        expect(resolveCurrentVoiceInfo(userId, voiceStore, {
            getChannel: (id: string) => id === 'voice-current' ? channel : null,
        })).toEqual({
            channelId: 'voice-current',
            guildId: 'guild-current',
            channel,
        })
    })

    test('counts voice states and recognizes a full channel', () => {
        const cap = getVoiceChannelCapacity(
            { userLimit: 2 },
            {
                one: { channelId: 'vc-a' },
                two: { channel_id: 'vc-a' },
                three: { channelId: 'vc-b' },
            },
            'vc-a',
        )
        expect(cap).toEqual({ occupancy: 2, reserved: 0, limit: 2, available: 0, isFull: true })
        expect(getVoiceChannelCapacity({ user_limit: 0 }, {}, 'vc-a')).toBeNull()
        expect(getVoiceChannelCapacity({}, {}, 'vc-a')).toBeNull()
        expect(getVoiceChannelCapacity(
            { userLimit: 3 },
            { one: { channelId: 'vc-a' } },
            'vc-a',
            2,
        )).toEqual({ occupancy: 1, reserved: 2, limit: 3, available: 0, isFull: true })
        expect(getVoiceChannelCapacity({ userLimit: 3 }, new Map([['x', { channelId: 'vc-a' }]]), 'vc-a'))
            .toEqual({ occupancy: 1, reserved: 0, limit: 3, available: 2, isFull: false })
    })

    test('waits while full and releases a queued user when a slot opens', () => {
        const waiting = new Set(['123456789012345'])
        expect(checkCapacityWait(waiting, '123456789012345', { occupancy: 2, reserved: 0, limit: 2, available: 0, isFull: true })).toBe('waiting')
        expect(waiting.has('123456789012345')).toBe(true)
        expect(checkCapacityWait(waiting, '123456789012345', { occupancy: 1, reserved: 0, limit: 2, available: 1, isFull: false })).toBe('released')
        expect(waiting.has('123456789012345')).toBe(false)
        expect(checkCapacityWait(waiting, '234567890123456', null)).toBe('not-waiting')
    })

    test('does not pre-block an untried target solely because the channel is full', () => {
        const waiting = new Set<string>()
        const fullCapacity = {
            occupancy: 2,
            reserved: 0,
            limit: 2,
            available: 0,
            isFull: true,
        }

        // A first attempt must reach Discord so it can evaluate target overrides.
        expect(checkCapacityWait(waiting, '123456789012345', fullCapacity)).toBe('not-waiting')
    })

    test('recognizes capacity errors without classifying permission failures as capacity', () => {
        expect(isCapacityError('Voice channel is full')).toBe(true)
        expect(isCapacityError('The user limit has been reached')).toBe(true)
        expect(isCapacityError('Missing Permissions')).toBe(false)
    })

    test('parses nested error bodies and Retry-After values', () => {
        expect(getResponseBody({ response: { data: { message: 'full' } } })).toEqual({ message: 'full' })
        expect(getResponseBody({ body: '{"code":50013}' })).toEqual({ code: 50013 })
        expect(getResponseBody({ body: 'not-json' })).toBeNull()
        expect(getRetryAfterMs({ response: { headers: { 'retry-after': '2.5' } } })).toBe(2500)
        expect(getRetryAfterMs({})).toBe(10_000)
    })

    test('settings buttons reset runtime state and persist their action', () => {
        const updates: any[] = []
        let resets = 0
        const actions = createSettingsActions(
            { set(value) { updates.push(value) } },
            () => { resets++ },
        )
        actions.saveTargets(' 123456789012345 ')
        actions.startPull(' 123456789012345 ')
        actions.stopPull()
        expect(updates).toEqual([
            { userIds: '123456789012345' },
            { userIds: '123456789012345', enabled: true },
            { enabled: false, status: 'Pull is stopped.' },
        ])
        expect(resets).toBe(2)
    })
})

describe('Pull fast retry scheduling', () => {
    test('voice events schedule on the next event-loop turn', () => {
        expect(getReconcileDelayMs(true)).toBe(0)
    })

    test('poll fallback remains bounded and validated', () => {
        expect(getReconcileDelayMs(false, 250)).toBe(250)
        expect(getReconcileDelayMs(false, -1)).toBe(0)
        expect(getReconcileDelayMs(false, Number.NaN)).toBe(180)
    })

    test('capacity-waiting users are checked before new users for the same destination', () => {
        const ids = ['fresh-a', 'waiting-a', 'fresh-b', 'waiting-b']
        const waiting = new Set([
            capacityWaitKey('waiting-a', 'voice-a'),
            capacityWaitKey('waiting-b', 'voice-a'),
        ])
        expect(prioritizeWaitingTargets(ids, waiting, 'voice-a')).toEqual([
            'waiting-a',
            'waiting-b',
            'fresh-a',
            'fresh-b',
        ])
    })

    test('capacity waits from another destination do not block new attempts', () => {
        const ids = ['alt-a', 'alt-b']
        const waiting = new Set([capacityWaitKey('alt-a', 'voice-a')])
        expect(prioritizeWaitingTargets(ids, waiting, 'voice-b')).toEqual(ids)
    })
})
