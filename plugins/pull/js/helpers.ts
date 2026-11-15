export const MOVE_MEMBERS = 1n << 24n
export const CONNECT = 1n << 20n

export type TargetIds = { ids: string[]; overflow: boolean }
export type VoiceCapacity = { occupancy: number; reserved: number; limit: number; available: number; isFull: boolean } | null

export function parseTargetIds(value: unknown, maxTargets: number): TargetIds {
    const parts = String(value ?? '').split(/[\s,;]+/)
    const ids: string[] = []
    const seen = new Set<string>()

    for (const part of parts) {
        const id = part.trim()
        if (!/^\d{15,22}$/.test(id) || seen.has(id)) continue
        seen.add(id)
        ids.push(id)
    }

    return {
        ids: ids.slice(0, maxTargets),
        overflow: ids.length > maxTargets,
    }
}

export function canMoveBetween(permissionStore: any, sourceChannel: any, destinationChannel: any): boolean {
    if (!permissionStore || typeof permissionStore.can !== 'function') return false
    if (!sourceChannel || !destinationChannel) return false

    try {
        // Discord requires the acting account to have Connect in the destination
        // and Move Members permission for this member move.
        return (
            permissionStore.can(MOVE_MEMBERS, sourceChannel) === true &&
            permissionStore.can(MOVE_MEMBERS, destinationChannel) === true &&
            permissionStore.can(CONNECT, destinationChannel) === true
        )
    } catch {
        return false
    }
}

export function getVoiceChannelCapacity(
    channel: any,
    guildVoiceStates: any,
    channelId: string,
    reservedSlots = 0,
): VoiceCapacity {
    const rawLimit = channel?.userLimit ?? channel?.user_limit
    if (
        rawLimit === null ||
        rawLimit === undefined ||
        !guildVoiceStates ||
        typeof guildVoiceStates !== 'object'
    ) {
        return null
    }

    const parsedLimit = Number(rawLimit)
    const parsedReserved = Number(reservedSlots)
    if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) return null
    if (!Number.isFinite(parsedReserved) || parsedReserved < 0) return null

    const limit = Math.floor(parsedLimit)
    const reserved = Math.floor(parsedReserved)
    if (limit <= 0) return null

    const states: any[] = guildVoiceStates instanceof Map
        ? Array.from(guildVoiceStates.values())
        : Object.values(guildVoiceStates)

    let occupancy = 0
    for (const state of states) {
        const voiceChannelId = state?.channelId ?? state?.channel_id
        if (voiceChannelId != null && String(voiceChannelId) === String(channelId)) occupancy++
    }

    const available = Math.max(0, limit - occupancy - reserved)
    return { occupancy, reserved, limit, available, isFull: available === 0 }
}

export function checkCapacityWait(
    waitingUsers: Set<string>,
    userId: string,
    capacity: VoiceCapacity,
): 'not-waiting' | 'waiting' | 'released' {
    if (!waitingUsers.has(userId)) return 'not-waiting'
    if (capacity?.isFull) return 'waiting'
    waitingUsers.delete(userId)
    return 'released'
}

export function getResponseBody(response: any): any {
    let body = response?.body ?? response?.data ?? response?.response?.body ?? response?.response?.data ?? response
    if (typeof body === 'string') {
        try {
            body = JSON.parse(body)
        } catch {
            return null
        }
    }
    return body
}

export function getRetryAfterMs(error: any, fallbackMs = 10_000): number {
    const candidates = [
        error?.body?.retry_after,
        error?.response?.body?.retry_after,
        error?.data?.retry_after,
        error?.headers?.['retry-after'],
        error?.response?.headers?.['retry-after'],
    ]
    for (const candidate of candidates) {
        const seconds = Number(candidate)
        if (Number.isFinite(seconds) && seconds > 0) {
            return Math.min(120_000, Math.ceil(seconds * 1000))
        }
    }
    return fallbackMs
}

export function isCapacityError(message: string): boolean {
    return /channel is full|voice channel is full|user.?limit|maximum.{0,30}(user|member)|capacity|too many.{0,20}(user|member)/i.test(
        String(message ?? ''),
    )
}

export function createSettingsActions(
    storage: { set: (value: any) => unknown },
    resetRuntimeState?: (() => void) | null,
) {
    return {
        saveTargets(draft: string) {
            return storage.set({ userIds: draft.trim() })
        },
        startPull(draft: string) {
            resetRuntimeState?.()
            return storage.set({
                userIds: draft.trim(),
                enabled: true,
            })
        },
        stopPull() {
            resetRuntimeState?.()
            return storage.set({ enabled: false, status: 'Pull is stopped.' })
        },
    }
}

/** Put previously capacity-blocked users first so they get the next available slot. */
export function prioritizeWaitingTargets(
    targetIds: string[],
    waitingUsers: ReadonlySet<string>,
): string[] {
    return [
        ...targetIds.filter(userId => waitingUsers.has(userId)),
        ...targetIds.filter(userId => !waitingUsers.has(userId)),
    ]
}

/** Event-driven reconciles can run on the next event-loop turn; polling uses a fallback. */
export function getReconcileDelayMs(immediate: boolean, fallbackMs = 180): number {
    if (immediate) return 0
    return Number.isFinite(fallbackMs) ? Math.max(0, Math.floor(fallbackMs)) : 180
}
