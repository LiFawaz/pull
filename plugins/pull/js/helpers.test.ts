import { describe, expect, test } from 'bun:test'
import {
    CONNECT,
    MOVE_MEMBERS,
    canMoveBetween,
    checkCapacityWait,
    createSettingsActions,
    getResponseBody,
    getRetryAfterMs,
    getVoiceChannelCapacity,
    isCapacityError,
    parseTargetIds,
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

    test('rejects malformed IDs', () => {
        expect(parseTargetIds('abc 1234 -123456789012345', 20)).toEqual({
            ids: [],
            overflow: false,
        })
    })

    test('requires Move Members and destination Connect from the acting account', () => {
        const source = { id: 'source' }
        const destination = { id: 'destination' }
        const granted = new Set([MOVE_MEMBERS.toString() + ':source', MOVE_MEMBERS.toString() + ':destination', CONNECT.toString() + ':destination'])
        const store = {
            can(permission: bigint, channel: { id: string }) {
                return granted.has(permission.toString() + ':' + channel.id)
            },
        }
        expect(canMoveBetween(store, source, destination)).toBe(true)
        granted.delete(CONNECT.toString() + ':destination')
        expect(canMoveBetween(store, source, destination)).toBe(false)
        granted.add(CONNECT.toString() + ':destination')
        granted.delete(MOVE_MEMBERS.toString() + ':source')
        expect(canMoveBetween(store, source, destination)).toBe(false)
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
