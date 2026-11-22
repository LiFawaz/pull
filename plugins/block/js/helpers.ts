export const MUTE_MEMBERS = 1n << 22n
export const DEAFEN_MEMBERS = 1n << 23n
export const MOVE_MEMBERS = 1n << 24n

export type VoiceInfo = {
    channelId: string | null
    guildId: string | null
    channel: any
}

export type ParsedIds = {
    ids: string[]
    overflow: boolean
    invalid: string[]
}

const DISCORD_ID_PATTERN = /^\d{15,22}$/

export function parseTargetIds(value: unknown, maxTargets: number): ParsedIds {
    const parts = String(value ?? '').split(/[\s,;]+/)
    const ids: string[] = []
    const invalid: string[] = []
    const seen = new Set<string>()

    for (const rawPart of parts) {
        const id = rawPart.trim()
        if (!id) continue
        if (!DISCORD_ID_PATTERN.test(id)) {
            invalid.push(id)
            continue
        }
        if (seen.has(id)) continue
        seen.add(id)
        ids.push(id)
    }

    return {
        ids: ids.slice(0, maxTargets),
        overflow: ids.length > maxTargets,
        invalid,
    }
}

export function parseCommandIds(
    args: unknown,
    maxTargets: number,
): { ids: string[]; error: string | null } {
    const options = Array.isArray(args) ? args : []
    const values = options
        .filter((arg: any) => /^id\d+$/.test(String(arg?.name ?? '')))
        .map((arg: any) => String(arg?.value ?? '').trim())
        .filter((value: string) => value.length > 0)

    if (!values.length) {
        return { ids: [], error: 'Enter at least one ID in id1 or another ID field.' }
    }

    if (values.some((id: string) => !DISCORD_ID_PATTERN.test(id))) {
        return { ids: [], error: 'Each ID field must contain a numeric Discord user ID (15-22 digits).' }
    }

    const ids = [...new Set(values)]
    if (ids.length > maxTargets) {
        return { ids: [], error: 'You can enter up to ' + maxTargets + ' different user IDs.' }
    }

    return { ids, error: null }
}

function readVoiceStoreMethod(store: any, name: string, ...args: any[]): any {
    try {
        const method = store?.[name]
        return typeof method === 'function' ? method.apply(store, args) : undefined
    } catch {
        return undefined
    }
}

function voiceInfoFromState(
    state: any,
    indexedGuildId: string | null,
    channelStore: any,
): VoiceInfo {
    if (!state) return { channelId: null, guildId: indexedGuildId, channel: null }

    const rawChannelId = state.channelId ?? state.channel_id
    if (rawChannelId == null || String(rawChannelId).length === 0) {
        const rawGuildId = indexedGuildId ?? state.guildId ?? state.guild_id ?? null
        return {
            channelId: null,
            guildId: rawGuildId == null ? null : String(rawGuildId),
            channel: null,
        }
    }

    const channelId = String(rawChannelId)
    let channel: any = null
    try {
        channel = channelStore?.getChannel?.(channelId) ?? null
    } catch {
        channel = null
    }

    const rawGuildId =
        indexedGuildId ??
        state.guildId ??
        state.guild_id ??
        channel?.guildId ??
        channel?.guild_id ??
        null

    return {
        channelId,
        guildId: rawGuildId == null ? null : String(rawGuildId),
        channel,
    }
}

function getGuildEntries(all: any): Array<[string, any]> {
    if (all instanceof Map) {
        return Array.from(all.entries(), ([guildId, members]) => [String(guildId), members])
    }
    if (all && typeof all === 'object') return Object.entries(all)
    return []
}

export function resolveCurrentVoiceInfo(
    userId: string,
    voiceStore: any,
    channelStore: any,
): VoiceInfo {
    const all = readVoiceStoreMethod(voiceStore, 'getAllVoiceStates')
    const guildEntries = getGuildEntries(all)

    for (const [guildId] of guildEntries) {
        if (guildId === '@me') continue

        const activeChannelId = readVoiceStoreMethod(
            voiceStore,
            'getCurrentClientVoiceChannelId',
            guildId,
        )
        if (activeChannelId != null && String(activeChannelId).length > 0) {
            const channelId = String(activeChannelId)
            let channel: any = null
            try {
                channel = channelStore?.getChannel?.(channelId) ?? null
            } catch {}
            return { channelId, guildId, channel }
        }

        const userChannelId = readVoiceStoreMethod(
            voiceStore,
            'getUserVoiceChannelId',
            guildId,
            userId,
        )
        if (userChannelId != null && String(userChannelId).length > 0) {
            const channelId = String(userChannelId)
            let channel: any = null
            try {
                channel = channelStore?.getChannel?.(channelId) ?? null
            } catch {}
            return { channelId, guildId, channel }
        }

        const members = all instanceof Map ? all.get(guildId) : all?.[guildId]
        const indexedState = members instanceof Map ? members.get(userId) : members?.[userId]
        const state = readVoiceStoreMethod(voiceStore, 'getVoiceState', guildId, userId) ?? indexedState

        const info = voiceInfoFromState(state, guildId, channelStore)
        if (info.channelId) return info
    }

    const ownState = readVoiceStoreMethod(voiceStore, 'getVoiceStateForUser', userId)
    const ownInfo = voiceInfoFromState(ownState, null, channelStore)
    return ownInfo.channelId && ownInfo.guildId
        ? ownInfo
        : { channelId: null, guildId: null, channel: null }
}

export function resolveUserVoiceInfo(
    userId: string,
    preferredGuildId: string | null,
    voiceStore: any,
    channelStore: any,
): VoiceInfo {
    if (preferredGuildId) {
        const direct =
            readVoiceStoreMethod(voiceStore, 'getVoiceState', preferredGuildId, userId) ??
            readVoiceStoreMethod(voiceStore, 'getVoiceStates', preferredGuildId)?.[userId] ??
            readVoiceStoreMethod(voiceStore, 'getAllVoiceStates')?.[preferredGuildId]?.[userId]

        if (direct) return voiceInfoFromState(direct, preferredGuildId, channelStore)

        const all = readVoiceStoreMethod(voiceStore, 'getAllVoiceStates')
        if (all instanceof Map) {
            const memberStates = all.get(preferredGuildId)
            const state = memberStates instanceof Map
                ? memberStates.get(userId)
                : memberStates?.[userId]
            if (state) return voiceInfoFromState(state, preferredGuildId, channelStore)
        }
    }

    const all = readVoiceStoreMethod(voiceStore, 'getAllVoiceStates')
    for (const [guildId, members] of getGuildEntries(all)) {
        if (guildId === '@me' || !members || typeof members !== 'object') continue
        const state = members instanceof Map ? members.get(userId) : members[userId]
        if (state) return voiceInfoFromState(state, guildId, channelStore)
    }

    const state = readVoiceStoreMethod(voiceStore, 'getVoiceStateForUser', userId)
    if (state) return voiceInfoFromState(state, null, channelStore)

    return { channelId: null, guildId: null, channel: null }
}

export function hasPermission(
    permissionStore: any,
    permission: bigint,
    channel: any,
): boolean {
    if (!permissionStore || typeof permissionStore.can !== 'function' || !channel) return false
    try {
        return Boolean(permissionStore.can(permission, channel))
    } catch {
        return false
    }
}

export function getNewVoiceEntrants(
    ids: string[],
    guildId: string,
    channelId: string,
    presence: Map<string, boolean>,
    resolveTarget: (userId: string) => VoiceInfo,
): string[] {
    const prefix = guildId + ':' + channelId + ':'
    for (const key of presence.keys()) {
        if (!key.startsWith(prefix)) presence.delete(key)
    }

    const entrants: string[] = []
    for (const id of ids) {
        const key = prefix + id
        const target = resolveTarget(id)
        const present = target.guildId === guildId && target.channelId === channelId
        const wasPresent = presence.get(key) ?? false
        presence.set(key, present)
        if (present && !wasPresent) entrants.push(id)
    }
    return entrants
}

export function getDiscordErrorMessage(error: any): string {
    const bodyCandidate =
        error?.body ??
        error?.data ??
        error?.response?.body ??
        error?.response?.data ??
        error

    let body: any = bodyCandidate
    if (typeof bodyCandidate === 'string') {
        try {
            body = JSON.parse(bodyCandidate)
        } catch {
            body = null
        }
    }

    const status = Number(
        error?.status ??
        error?.statusCode ??
        error?.response?.status ??
        0,
    )
    const code = Number(body?.code ?? error?.code ?? 0)
    const message = String(body?.message ?? error?.message ?? '').trim()

    const details: string[] = []
    if (status > 0) details.push('HTTP ' + status)
    if (code > 0) details.push('Discord code ' + code)
    if (message && message !== 'Error') details.push(message.slice(0, 140))
    return details.join('; ')
}


export function resolveVoiceState(
    userId: string,
    guildId: string,
    voiceStore: any,
): any | null {
    const call = (name: string, ...args: any[]) => {
        try {
            const method = voiceStore?.[name]
            return typeof method === 'function' ? method.apply(voiceStore, args) : undefined
        } catch { return undefined }
    }

    const direct = call('getVoiceState', guildId, userId)
        ?? call('getVoiceStates', guildId)?.[userId]
    if (direct) return direct

    const all = call('getAllVoiceStates')
    const guildStates = all instanceof Map ? all.get(guildId) : all?.[guildId]
    if (guildStates instanceof Map) return guildStates.get(userId) ?? null
    if (guildStates && typeof guildStates === 'object') return guildStates[userId] ?? null
    return null
}

export function needsVoiceEnforcement(
    state: any,
    muteEnabled: boolean,
    deafenEnabled: boolean,
): boolean {
    return (muteEnabled && state?.mute !== true) ||
        (deafenEnabled && state?.deaf !== true)
}


export function getDiscordRetryAfterMs(error: any): number {
    const response = error?.response ?? error
    const bodyCandidate =
        error?.body ??
        error?.data ??
        response?.body ??
        response?.data ??
        response
    let body: any = bodyCandidate
    if (typeof bodyCandidate === 'string') {
        try { body = JSON.parse(bodyCandidate) } catch { body = null }
    }

    const retryAfterSeconds = Number(body?.retry_after)
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
        return Math.ceil(retryAfterSeconds * 1000)
    }

    try {
        const headers = response?.headers ?? error?.headers
        const headerValue = typeof headers?.get === 'function'
            ? headers.get('retry-after')
            : headers?.['retry-after'] ?? headers?.['Retry-After']
        const headerSeconds = Number(headerValue)
        if (Number.isFinite(headerSeconds) && headerSeconds > 0) {
            return Math.ceil(headerSeconds * 1000)
        }
    } catch {}

    return 0
}
