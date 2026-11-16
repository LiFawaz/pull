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

export function getMovePermissionIssue(permissionStore: any, destinationChannel: any): string | null {
    if (!permissionStore || typeof permissionStore.can !== 'function') return 'PermissionStore unavailable'
    if (!destinationChannel) return 'destination channel unavailable'

    try {
        // Discord requires the active account's Move Members and Connect
        // permissions for the destination channel. The target's source channel
        // is not part of this permission pre-check.
        if (!Boolean(permissionStore.can(MOVE_MEMBERS, destinationChannel))) return 'Move Members'
        if (!Boolean(permissionStore.can(CONNECT, destinationChannel))) return 'Connect'
        return null
    } catch {
        return 'permission check failed'
    }
}

export function canMoveBetween(permissionStore: any, destinationChannel: any): boolean {
    return getMovePermissionIssue(permissionStore, destinationChannel) === null
}

function getCollectionValue(collection: any, key: string): any {
    if (collection instanceof Map) {
        const direct = collection.get(key)
        if (direct !== undefined) return direct
        for (const [entryKey, value] of collection.entries()) {
            if (String(entryKey) === String(key)) return value
        }
        return undefined
    }

    if (collection && typeof collection === 'object') return collection[key]
    return undefined
}

function getCollectionEntries(collection: any): Array<[string, any]> {
    if (collection instanceof Map) {
        return Array.from(collection.entries(), ([key, value]) => [String(key), value])
    }
    if (collection && typeof collection === 'object') return Object.entries(collection)
    return []
}

/** Return a guild's voice-state collection without assuming object-backed stores. */
export function getGuildVoiceStates(allVoiceStates: any, guildId: string): any {
    return getCollectionValue(allVoiceStates, String(guildId)) ?? null
}

function makeUserVoiceInfo(state: any, indexedGuildId: string | null, channelStore: any) {
    const rawChannelId = state?.channelId ?? state?.channel_id
    const channelId = rawChannelId == null || String(rawChannelId).length === 0
        ? null
        : String(rawChannelId)

    let channel: any = null
    if (channelId) {
        try {
            channel = channelStore?.getChannel?.(channelId) ?? null
        } catch {
            channel = null
        }
    }

    const rawGuildId =
        indexedGuildId ??
        state?.guildId ??
        state?.guild_id ??
        channel?.guildId ??
        channel?.guild_id

    return {
        channelId,
        guildId: rawGuildId == null ? null : String(rawGuildId),
        channel,
    }
}

/**
 * Resolve a configured target in the destination guild first. Discord stores may
 * expose voice states as plain objects or nested Maps; both shapes are supported.
 */
export function resolveUserVoiceInfo(
    userId: string,
    preferredGuildId: string | null | undefined,
    voiceStore: any,
    channelStore: any,
) {
    const disconnected = { channelId: null, guildId: null, channel: null }

    const call = (methodName: string, ...args: any[]) => {
        try {
            const method = voiceStore?.[methodName]
            return typeof method === 'function' ? method.apply(voiceStore, args) : undefined
        } catch {
            return undefined
        }
    }

    const all = call('getAllVoiceStates')

    if (preferredGuildId) {
        const preferredId = String(preferredGuildId)
        const directState =
            call('getVoiceState', preferredId, userId) ??
            getCollectionValue(call('getVoiceStates', preferredId), userId) ??
            getCollectionValue(getCollectionValue(all, preferredId), userId)

        if (directState != null) {
            return makeUserVoiceInfo(directState, preferredId, channelStore)
        }
    }

    let disconnectedCandidate: ReturnType<typeof makeUserVoiceInfo> | null = null

    for (const [guildId, members] of getCollectionEntries(all)) {
        if (guildId === '@me') continue
        const state = getCollectionValue(members, userId)
        if (!state) continue

        const info = makeUserVoiceInfo(state, guildId, channelStore)
        if (preferredGuildId && info.guildId === String(preferredGuildId)) return info
        if (info.channelId) return info
        disconnectedCandidate ??= info
    }

    if (disconnectedCandidate) return disconnectedCandidate

    const globalState = call('getVoiceStateForUser', userId)
    if (globalState) {
        return makeUserVoiceInfo(
            globalState,
            globalState?.guildId ?? globalState?.guild_id ?? null,
            channelStore,
        )
    }

    return disconnected
}

export function resolveCurrentVoiceInfo(userId: string, voiceStore: any, channelStore: any) {
    const disconnected = { channelId: null, guildId: null, channel: null }

    const call = (methodName: string, ...args: any[]) => {
        try {
            const method = voiceStore?.[methodName]
            return typeof method === 'function' ? method.apply(voiceStore, args) : undefined
        } catch {
            return undefined
        }
    }

    const toInfo = (rawChannelId: any, rawGuildId: any) => {
        if (rawChannelId == null || rawGuildId == null || String(rawChannelId).length === 0) return null
        const channelId = String(rawChannelId)
        const guildId = String(rawGuildId)
        let channel: any = null
        try {
            channel = channelStore?.getChannel?.(channelId) ?? null
        } catch {
            channel = null
        }
        return { channelId, guildId, channel }
    }

    let all: any
    const guildIds: string[] = []
    try {
        all = call('getAllVoiceStates')
        guildIds.push(...getCollectionEntries(all).map(([guildId]) => guildId))
    } catch {
        // The direct per-user lookup below is still available.
    }

    for (const guildId of guildIds) {
        if (guildId === '@me') continue

        // Discord's current-client lookup is authoritative and can update
        // before the cached per-user voice-state object after a reconnect.
        const activeInfo = toInfo(call('getCurrentClientVoiceChannelId', guildId), guildId)
        if (activeInfo) return activeInfo

        const userChannelInfo = toInfo(call('getUserVoiceChannelId', guildId, userId), guildId)
        if (userChannelInfo) return userChannelInfo

        const state = call('getVoiceState', guildId, userId) ??
            getCollectionValue(getCollectionValue(all, guildId), userId)
        const stateInfo = toInfo(
            state?.channelId ?? state?.channel_id,
            state?.guildId ?? state?.guild_id ?? guildId,
        )
        if (stateInfo) return stateInfo
    }

    // Official per-user fallback: this also provides the guild ID.
    const ownState = call('getVoiceStateForUser', userId)
    const ownInfo = toInfo(
        ownState?.channelId ?? ownState?.channel_id,
        ownState?.guildId ?? ownState?.guild_id,
    )
    if (ownInfo) return ownInfo

    return disconnected
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

/** Scope a capacity wait to both the user and the destination channel. */
export function capacityWaitKey(userId: string, channelId: string): string {
    return `${channelId}:${userId}`
}

/** Put users waiting for this exact destination ahead of new targets. */
export function prioritizeWaitingTargets(
    targetIds: string[],
    waitingKeys: ReadonlySet<string>,
    channelId: string,
): string[] {
    return [
        ...targetIds.filter(userId => waitingKeys.has(capacityWaitKey(userId, channelId))),
        ...targetIds.filter(userId => !waitingKeys.has(capacityWaitKey(userId, channelId))),
    ]
}

/** Event-driven reconciles can run on the next event-loop turn; polling uses a fallback. */
export function getReconcileDelayMs(immediate: boolean, fallbackMs = 180): number {
    if (immediate) return 0
    return Number.isFinite(fallbackMs) ? Math.max(0, Math.floor(fallbackMs)) : 180
}
