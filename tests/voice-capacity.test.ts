import { describe, expect, test } from 'bun:test'
import { calculateVoiceCapacity } from '../plugins/pull/js/voice-capacity'

describe('Pull voice-channel capacity', () => {
    test('treats a zero user limit as unlimited', () => {
        expect(calculateVoiceCapacity(0, 99)).toBeNull()
    })

    test('treats missing or invalid capacity data as unknown', () => {
        expect(calculateVoiceCapacity(undefined, 0)).toBeNull()
        expect(calculateVoiceCapacity(5, Number.NaN)).toBeNull()
        expect(calculateVoiceCapacity(-1, 0)).toBeNull()
    })

    test('detects a channel that is already full before sending a move', () => {
        expect(calculateVoiceCapacity(2, 2)).toEqual({
            occupancy: 2,
            reserved: 0,
            limit: 2,
            available: 0,
            isFull: true,
        })
    })

    test('allows exactly one move when one slot is open', () => {
        const capacity = calculateVoiceCapacity(3, 2)
        expect(capacity?.available).toBe(1)
        expect(capacity?.isFull).toBe(false)
    })

    test('reserves a slot for a move awaiting voice-state confirmation', () => {
        const capacity = calculateVoiceCapacity(3, 2, 1)
        expect(capacity?.available).toBe(0)
        expect(capacity?.isFull).toBe(true)
    })

    test('does not allow queued moves to overbook reserved slots', () => {
        const firstMove = calculateVoiceCapacity(2, 1)
        expect(firstMove?.isFull).toBe(false)

        const afterFirstMoveIsPending = calculateVoiceCapacity(
            2,
            firstMove!.occupancy,
            firstMove!.reserved + 1,
        )
        expect(afterFirstMoveIsPending?.available).toBe(0)
        expect(afterFirstMoveIsPending?.isFull).toBe(true)
    })

    test('clamps occupancy and reservations to whole non-negative members', () => {
        expect(calculateVoiceCapacity(4, 1.9, 1.8)).toEqual({
            occupancy: 1,
            reserved: 1,
            limit: 4,
            available: 2,
            isFull: false,
        })
    })
})
