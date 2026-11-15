export interface VoiceCapacity {
    occupancy: number
    reserved: number
    limit: number
    available: number
    isFull: boolean
}

/**
 * Returns a capacity snapshot for a limited voice channel.
 * A zero limit means unlimited; missing or invalid data means unknown.
 */
export function calculateVoiceCapacity(
    rawLimit: unknown,
    rawOccupancy: unknown,
    rawReserved: unknown = 0,
): VoiceCapacity | null {
    if (rawLimit === null || rawLimit === undefined || rawLimit === '') return null

    const parsedLimit = Number(rawLimit)
    const parsedOccupancy = Number(rawOccupancy)
    const parsedReserved = Number(rawReserved)

    if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) return null
    if (!Number.isFinite(parsedOccupancy) || parsedOccupancy < 0) return null
    if (!Number.isFinite(parsedReserved) || parsedReserved < 0) return null

    const limit = Math.floor(parsedLimit)
    const occupancy = Math.floor(parsedOccupancy)
    const reserved = Math.floor(parsedReserved)
    if (limit <= 0) return null

    const available = Math.max(0, limit - occupancy - reserved)

    return {
        occupancy,
        reserved,
        limit,
        available,
        isFull: available === 0,
    }
}
