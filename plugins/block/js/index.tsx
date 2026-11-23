import React from 'react'
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { getStore, onAnyFluxEventDispatched } from '@valenced/discord/flux'
import { getModules } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import {
    getDiscordErrorMessage,
    getDiscordRetryAfterMs,
    getRequiredActions,
    hasPermission,
    parseCommandIds,
    parseTargetIds,
    resolveCurrentVoiceInfo,
    resolveUserVoiceInfo,
    resolveVoiceState,
} from './helpers'

interface BlockSettings {
    userIds: string
    enabled: boolean
    mute: boolean
    deafen: boolean
    disconnect: boolean
    status: string
    targetStatus: string
}

const DEFAULT_SETTINGS: BlockSettings = {
    userIds: '',
    enabled: false,
    mute: true,
    deafen: true,
    disconnect: true,
    status: 'Block is paused.',
    targetStatus: 'No enforcement is running.',
}

const MAX_TARGETS = 20
const POLL_INTERVAL_MS = 1000
const CONFIRMATION_TIMEOUT_MS = 5000
const FALLBACK_RETRY_MS = 1000
const MUTE_MEMBERS = 1n << 22n
const DEAFEN_MEMBERS = 1n << 23n
const MOVE_MEMBERS = 1n << 24n

type ActionName = 'mute' | 'deafen' | 'disconnect'
type PendingAction = {
    inFlight: boolean
    requestedAt: number
    retryAt: number
    blocked: boolean
    detail?: string
}

function responseBody(value: any): any {
    const candidate = value?.body ?? value?.data ?? value?.response?.body ?? value?.response?.data
    if (candidate && typeof candidate === 'object') return candidate
    if (typeof candidate === 'string') {
        try { return JSON.parse(candidate) } catch { return null }
    }
    return null
}

export default plugin<{ jsonStorage: BlockSettings }>({
    jsonStorage: { load: true, default: DEFAULT_SETTINGS },

    start(api) {
        const { cleanup, jsonStorage, logger } = api
        let stopped = false
        let timer: ReturnType<typeof setTimeout> | null = null
        let poll: ReturnType<typeof setInterval> | null = null
        let reconciling = false
        let reconcileAgain = false

        let userStore: any = null
        let voiceStore: any = null
        let selectedChannelStore: any = null
        let channelStore: any = null
        let permissionStore: any = null
        let http: any = null

        let lastStatus = ''
        let lastTargetStatus = ''
        let lastVoiceSession = ''
        const pending = new Map<string, PendingAction>()
        const commandUnsubscribers: Array<() => void> = []

        const saveStatus = (message: string, details: string) => {
            if (lastStatus === message && lastTargetStatus === details) return
            lastStatus = message
            lastTargetStatus = details
            try {
                Promise.resolve(jsonStorage.set({ status: message, targetStatus: details }))
                    .catch((error: any) => logger?.error?.('[Block] Could not save status', error))
            } catch (error) {
                logger?.error?.('[Block] Could not save status', error)
            }
            logger?.log?.('[Block]', message, details)
        }

        const currentUserId = (): string | null => {
            try {
                const id = userStore?.getCurrentUser?.()?.id
                return id == null ? null : String(id)
            } catch (error) {
                logger?.warn?.('[Block] Could not read current user', error)
                return null
            }
        }

        const schedule = (immediate = false) => {
            if (stopped) return
            if (timer) {
                if (!immediate) return
                clearTimeout(timer)
            }
            timer = setTimeout(() => {
                timer = null
                void reconcile()
            }, immediate ? 0 : 150)
        }

        const actionKey = (guildId: string, channelId: string, userId: string, action: ActionName) =>
            guildId + ':' + channelId + ':' + userId + ':' + action

        const clearUserPending = (guildId: string, channelId: string, userId: string) => {
            const prefix = guildId + ':' + channelId + ':' + userId + ':'
            for (const key of pending.keys()) if (key.startsWith(prefix)) pending.delete(key)
        }

        const clearBlockedActions = () => {
            for (const [key, item] of pending) {
                if (item.blocked) pending.delete(key)
            }
        }

        async function applyAction(
            userId: string,
            guildId: string,
            channelId: string,
            action: ActionName,
        ): Promise<string> {
            const settings = jsonStorage.cache ?? DEFAULT_SETTINGS
            if (!settings.enabled || settings[action] === false) return action + ': disabled'

            const ownId = currentUserId()
            if (!ownId || !permissionStore || !http || !voiceStore || !channelStore) {
                return action + ': waiting for Discord stores or HTTP'
            }

            const own = resolveCurrentVoiceInfo(ownId, voiceStore, channelStore, selectedChannelStore)
            const target = resolveUserVoiceInfo(userId, guildId, voiceStore, channelStore)
            if (own.guildId !== guildId || own.channelId !== channelId ||
                target.guildId !== guildId || target.channelId !== channelId) {
                clearUserPending(guildId, channelId, userId)
                return action + ': skipped; voice session changed'
            }

            const channel = own.channel ?? channelStore?.getChannel?.(channelId) ?? null
            if (!channel) return action + ': waiting for channel data'

            const state = resolveVoiceState(userId, guildId, voiceStore)
            if (!state) return action + ': waiting for target voice state'

            const alreadySatisfied =
                action === 'mute' ? state.mute === true :
                action === 'deafen' ? state.deaf === true :
                false
            if (alreadySatisfied) {
                pending.delete(actionKey(guildId, channelId, userId, action))
                return action + ': confirmed'
            }

            const permission =
                action === 'mute' ? MUTE_MEMBERS :
                action === 'deafen' ? DEAFEN_MEMBERS :
                MOVE_MEMBERS
            if (!hasPermission(permissionStore, permission, channel)) {
                return action + ': permission unavailable'
            }

            const key = actionKey(guildId, channelId, userId, action)
            const now = Date.now()
            const previous = pending.get(key)
            if (previous?.blocked) return action + ': Discord previously rejected permission'
            if (previous?.inFlight) return action + ': request in progress'
            if (previous?.retryAt > now) return action + ': waiting for Discord rate limit'
            if (previous?.requestedAt && now - previous.requestedAt < CONFIRMATION_TIMEOUT_MS) {
                return action + ': waiting for voice-state confirmation'
            }

            const entry: PendingAction = {
                inFlight: true,
                requestedAt: 0,
                retryAt: 0,
                blocked: false,
            }
            pending.set(key, entry)

            const body = action === 'mute' ? { mute: true } :
                action === 'deafen' ? { deaf: true } :
                { channel_id: null }

            try {
                const response = await http.patch({
                    url: '/guilds/' + guildId + '/members/' + userId,
                    body,
                })
                const status = Number(response?.status ?? response?.statusCode ?? 0)
                if (status === 429) {
                    const retryAfter = getDiscordRetryAfterMs(response) || getDiscordRetryAfterMs({ response }) || FALLBACK_RETRY_MS
                    entry.inFlight = false
                    entry.retryAt = Date.now() + retryAfter
                    entry.detail = 'HTTP 429; retry after ' + retryAfter + 'ms'
                    return action + ': rate limited'
                }
                if (response?.ok === false || status >= 400) {
                    const error: any = new Error(getDiscordErrorMessage(response) || ('HTTP ' + status))
                    error.status = status
                    error.body = responseBody(response)
                    throw error
                }

                entry.inFlight = false
                entry.requestedAt = Date.now()
                entry.detail = 'Request accepted; awaiting Discord state confirmation'
                return action + ': request accepted; awaiting confirmation'
            } catch (error: any) {
                const detail = getDiscordErrorMessage(error) || String(error?.message ?? error)
                const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status ?? 0)
                const bodyData = responseBody(error)
                const code = Number(bodyData?.code ?? error?.code ?? error?.response?.data?.code ?? 0)
                entry.inFlight = false
                entry.requestedAt = 0
                entry.detail = detail

                if (status === 429) {
                    const retryAfter = getDiscordRetryAfterMs(error) || FALLBACK_RETRY_MS
                    entry.retryAt = Date.now() + retryAfter
                    return action + ': rate limited; retry scheduled'
                }
                if (status === 403 || code === 50013) {
                    entry.blocked = true
                    logger?.warn?.('[Block] Discord denied ' + action, { userId, guildId, detail, error })
                    return action + ': Discord denied permission (' + detail + ')'
                }

                entry.retryAt = Date.now() + CONFIRMATION_TIMEOUT_MS
                logger?.warn?.('[Block] ' + action + ' request failed', { userId, guildId, detail, error })
                return action + ': request failed (' + detail + ')'
            }
        }

        async function reconcile() {
            if (stopped) return
            if (reconciling) {
                reconcileAgain = true
                return
            }
            reconciling = true
            try {
                const settings = jsonStorage.cache ?? DEFAULT_SETTINGS
                if (!settings.enabled) {
                    pending.clear()
                    lastVoiceSession = ''
                    saveStatus(
                        'Block is paused. Saved IDs and settings are kept.',
                        'No voice-channel enforcement is running.',
                    )
                    return
                }

                const parsed = parseTargetIds(settings.userIds, MAX_TARGETS)
                if (parsed.invalid.length || parsed.overflow) {
                    saveStatus(
                        'Block cannot run because the saved ID list is invalid.',
                        parsed.invalid.length
                            ? 'Invalid IDs: ' + parsed.invalid.slice(0, 5).join(', ')
                            : 'Block supports up to ' + MAX_TARGETS + ' unique IDs.',
                    )
                    return
                }
                if (!parsed.ids.length) {
                    saveStatus('No blocked IDs are configured.', 'Add at least one valid Discord user ID.')
                    return
                }

                const missing: string[] = []
                if (!userStore) missing.push('UserStore')
                if (!voiceStore) missing.push('VoiceStateStore')
                if (!selectedChannelStore) missing.push('SelectedChannelStore (local voice channel)')
                if (!channelStore) missing.push('ChannelStore')
                if (!permissionStore) missing.push('PermissionStore')
                if (!http) missing.push('Discord HTTP')
                if (missing.length) {
                    saveStatus('Block is waiting for Discord initialization.', 'Not ready: ' + missing.join(', '))
                    return
                }

                const ownId = currentUserId()
                if (!ownId) {
                    saveStatus('Block is waiting for your Discord account.', 'UserStore has not returned the current account yet.')
                    return
                }

                const own = resolveCurrentVoiceInfo(ownId, voiceStore, channelStore, selectedChannelStore)
                if (!own.guildId || !own.channelId) {
                    pending.clear()
                    lastVoiceSession = ''
                    saveStatus('Block is enabled and waiting for you to join voice.', 'Enforcement pauses outside voice and resumes automatically when you join.')
                    return
                }

                const session = own.guildId + ':' + own.channelId
                if (session !== lastVoiceSession) {
                    pending.clear()
                    lastVoiceSession = session
                }

                const channel = own.channel ?? channelStore?.getChannel?.(own.channelId) ?? null
                if (!channel) {
                    saveStatus('Block is waiting for your current voice channel.', 'Channel ID: ' + own.channelId)
                    return
                }

                const ids = parsed.ids.filter(id => id !== ownId)
                const configured = new Set(ids)
                for (const key of pending.keys()) {
                    const parts = key.split(':')
                    if (parts.length >= 4 && !configured.has(parts[2])) pending.delete(key)
                }
                const present: string[] = []
                const diagnostics: string[] = []
                const tasks: Promise<string>[] = []

                for (const id of ids) {
                    const target = resolveUserVoiceInfo(id, own.guildId, voiceStore, channelStore)
                    if (target.guildId !== own.guildId || target.channelId !== own.channelId) {
                        clearUserPending(own.guildId, own.channelId, id)
                        continue
                    }

                    const state = resolveVoiceState(id, own.guildId, voiceStore)
                    if (!state) {
                        diagnostics.push(id + ': voice state is still loading')
                        continue
                    }
                    present.push(id)

                    const required = getRequiredActions(state, settings, true)
                    if (!required.length) {
                        diagnostics.push(id + ': all enabled voice states are already satisfied')
                        continue
                    }

                    for (const action of required) {
                        tasks.push(applyAction(id, own.guildId, own.channelId, action))
                    }
                }

                const results = await Promise.allSettled(tasks)
                for (const result of results) {
                    if (result.status === 'fulfilled') diagnostics.push(result.value)
                    else diagnostics.push('Action task failed: ' + String(result.reason))
                }

                const permissionSummary = [
                    settings.mute !== false ? 'Server Mute: ' + (hasPermission(permissionStore, MUTE_MEMBERS, channel) ? 'available' : 'not available') : 'Server Mute: off',
                    settings.deafen !== false ? 'Server Deafen: ' + (hasPermission(permissionStore, DEAFEN_MEMBERS, channel) ? 'available' : 'not available') : 'Server Deafen: off',
                    settings.disconnect !== false ? 'Disconnect: ' + (hasPermission(permissionStore, MOVE_MEMBERS, channel) ? 'available' : 'not available') : 'Disconnect: off',
                ].join(' | ')

                const details = [
                    'Current phone-client channel: ' + (channel.name ?? own.channelId) + ' (' + own.channelId + ')',
                    'Channel source: SelectedChannelStore.getVoiceChannelId()',
                    'Blocked IDs in this channel: ' + present.length + (present.length ? ' — ' + present.join(', ') : ''),
                    permissionSummary,
                    ...diagnostics.slice(0, 30),
                ].join('\n')

                const pendingCount = Array.from(pending.values()).filter(item => item.inFlight || item.requestedAt > 0 || item.retryAt > Date.now()).length
                saveStatus(
                    'Block active in your current voice channel. ' + present.length + ' blocked user(s) currently present.',
                    details + '\nPending confirmations/retries: ' + pendingCount,
                )
            } catch (error: any) {
                const message = error instanceof Error ? error.message : String(error ?? 'Unknown error')
                logger?.error?.('[Block] Reconciliation failed', { message, stack: error?.stack, error })
                saveStatus('Block encountered an internal error.', message + '. See Block debug logs.')
            } finally {
                reconciling = false
                if (reconcileAgain) {
                    reconcileAgain = false
                    schedule(true)
                }
            }
        }

        try {
            const registry = (api as any).commands?.commands
            if (typeof registry?.registerCommand !== 'function') {
                logger?.warn?.("[Block] Coco's Command Lib unavailable; use Configure instead.")
            } else {
                commandUnsubscribers.push(registry.registerCommand({
                    name: 'block',
                    displayName: 'block',
                    description: 'Enable Block for selected user IDs in your current voice channel',
                    displayDescription: 'Automatically enforce the enabled actions for up to 20 IDs in your current voice channel',
                    applicationId: '-1',
                    inputType: 1,
                    type: 1,
                    shouldHide: () => false,
                    options: Array.from({ length: MAX_TARGETS }, (_, index) => ({
                        name: 'id' + (index + 1),
                        displayName: 'id' + (index + 1),
                        description: 'Discord user ID ' + (index + 1),
                        displayDescription: 'Discord user ID to block',
                        type: 3,
                        required: index === 0,
                    })),
                    execute: async (args: any[]) => {
                        const parsed = parseCommandIds(args, MAX_TARGETS)
                        if (parsed.error) {
                            saveStatus('Could not enable Block.', parsed.error)
                            return
                        }
                        pending.clear()
                        await jsonStorage.set({
                            userIds: parsed.ids.join('\n'),
                            enabled: true,
                            status: 'Block is starting.',
                            targetStatus: 'Waiting for Discord stores and your current voice channel.',
                        })
                        lastStatus = ''
                        lastTargetStatus = ''
                        schedule(true)
                    },
                }))
                commandUnsubscribers.push(registry.registerCommand({
                    name: 'unblock',
                    displayName: 'unblock',
                    description: 'Pause Block without deleting saved IDs or settings',
                    displayDescription: 'Pause automatic voice enforcement',
                    applicationId: '-1',
                    inputType: 1,
                    type: 1,
                    shouldHide: () => false,
                    execute: async () => {
                        pending.clear()
                        await jsonStorage.set({
                            enabled: false,
                            status: 'Block is paused. Saved IDs and settings are kept.',
                            targetStatus: 'No voice-channel enforcement is running.',
                        })
                        lastStatus = ''
                        lastTargetStatus = ''
                        schedule(true)
                    },
                }))
            }
        } catch (error) {
            logger?.error?.('[Block] Could not register slash commands', error)
            saveStatus('Block slash commands could not be registered.', "Check that Coco's Command Lib is installed and enabled.")
        }

        const unUser = getStore('UserStore', (store: any) => { userStore = store; schedule(true) })
        const unVoice = getStore('VoiceStateStore', (store: any) => { voiceStore = store; schedule(true) })
        const unSelectedChannel = getStore('SelectedChannelStore', (store: any) => {
            if (typeof store?.getVoiceChannelId !== 'function') {
                logger?.warn?.('[Block] SelectedChannelStore was found but has no getVoiceChannelId method.')
                return
            }
            selectedChannelStore = store
            logger?.log?.('[Block] Local SelectedChannelStore is ready.')
            schedule(true)
        })
        const unChannel = getStore('ChannelStore', (store: any) => { channelStore = store; schedule(true) })
        const unPermission = getStore('PermissionStore', (store: any) => { permissionStore = store; schedule(true) })
        const unHttp = getModules(withProps('HTTP', 'get', 'patch'), (module: any) => {
            const candidate = module?.HTTP
            if (candidate && typeof candidate.patch === 'function') {
                http = candidate
                logger?.log?.('[Block] Discord HTTP module is ready.')
                schedule(true)
            }
        })

        const unFlux = onAnyFluxEventDispatched((payload: any) => {
            const type = String(payload?.type ?? '')
            if (type.includes('GUILD_ROLE_UPDATE') || type.includes('GUILD_MEMBER_UPDATE')) {
                clearBlockedActions()
            }
            if (
                type.includes('VOICE_STATE') ||
                type.includes('CHANNEL_UPDATE') ||
                type.includes('GUILD_ROLE_UPDATE') ||
                type.includes('GUILD_MEMBER_UPDATE')
            ) schedule(true)
            return payload
        })

        poll = setInterval(() => schedule(false), POLL_INTERVAL_MS)
        schedule(true)

        cleanup(
            unUser,
            unVoice,
            unSelectedChannel,
            unChannel,
            unPermission,
            unHttp,
            unFlux,
            ...commandUnsubscribers,
            () => {
                stopped = true
                if (timer) clearTimeout(timer)
                if (poll) clearInterval(poll)
                pending.clear()
                userStore = null
                voiceStore = null
                selectedChannelStore = null
                channelStore = null
                permissionStore = null
                http = null
            },
        )
    },

    SettingsComponent({ api }) {
        const settings = api.jsonStorage.use() ?? DEFAULT_SETTINGS
        const [draft, setDraft] = React.useState(String(settings.userIds ?? ''))
        const [validationError, setValidationError] = React.useState('')

        React.useEffect(() => {
            setDraft(String(settings.userIds ?? ''))
        }, [settings.userIds])

        const buttonStyle = {
            paddingVertical: 12,
            paddingHorizontal: 16,
            borderRadius: 10,
            alignItems: 'center' as const,
            marginTop: 8,
        }
        const buttonText = { color: '#FFFFFF', fontSize: 15, fontWeight: '700' as const }
        const textColor = '#F2F3F5'
        const muted = '#B5BAC1'

        const saveTargets = (enable: boolean) => {
            const parsed = parseTargetIds(draft, MAX_TARGETS)
            if (parsed.invalid.length || parsed.overflow || parsed.ids.length === 0) {
                setValidationError(
                    parsed.invalid.length
                        ? 'Invalid ID(s): ' + parsed.invalid.slice(0, 5).join(', ')
                        : parsed.overflow
                            ? 'You can save up to ' + MAX_TARGETS + ' unique IDs.'
                            : 'Add at least one Discord user ID.',
                )
                return
            }

            setValidationError('')
            const normalized = parsed.ids.join('\n')
            setDraft(normalized)
            void api.jsonStorage.set({
                userIds: normalized,
                ...(enable ? {
                    enabled: true,
                    status: 'Block is starting.',
                    targetStatus: 'Waiting for Discord stores and your current voice channel.',
                } : {}),
            })
        }

        const toggleMonitor = (key: 'mute' | 'deafen' | 'disconnect') => {
            void api.jsonStorage.set({ [key]: !settings[key] })
        }

        return (
            <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 32 }}>
                <View style={{ gap: 9 }}>
                    <Text style={{ color: textColor, fontSize: 22, fontWeight: '800' }}>Block</Text>
                    <Text style={{ color: muted, fontSize: 14, lineHeight: 20 }}>
                        Automatically apply the enabled server actions to selected Discord user IDs in the voice channel you are currently connected to.
                        Enforcement pauses when you leave voice and resumes when you join another channel.
                    </Text>

                    <Text style={{ color: textColor, fontSize: 16, fontWeight: '700', marginTop: 10 }}>Watched user IDs</Text>
                    <Text style={{ color: muted, fontSize: 12 }}>Enter up to 20 unique numeric Discord user IDs, one per line or separated by commas.</Text>
                    <TextInput
                        value={draft}
                        onChangeText={setDraft}
                        placeholder={'123456789012345678\n234567890123456789'}
                        placeholderTextColor="#72767D"
                        multiline
                        autoCapitalize="none"
                        autoCorrect={false}
                        keyboardType="numeric"
                        textAlignVertical="top"
                        style={{
                            minHeight: 130,
                            padding: 13,
                            borderRadius: 10,
                            color: textColor,
                            backgroundColor: 'rgba(128,128,128,0.16)',
                            borderWidth: 1,
                            borderColor: 'rgba(255,255,255,0.12)',
                            fontSize: 15,
                        }}
                    />

                    {!!validationError && <Text style={{ color: '#ED4245', fontSize: 13 }}>{validationError}</Text>}

                    <Pressable onPress={() => saveTargets(false)} style={{ ...buttonStyle, backgroundColor: '#4E5058' }}>
                        <Text style={buttonText}>Save IDs</Text>
                    </Pressable>
                    <Pressable onPress={() => saveTargets(true)} style={{ ...buttonStyle, backgroundColor: '#5865F2' }}>
                        <Text style={buttonText}>Enable Block</Text>
                    </Pressable>
                    <Pressable
                        onPress={() => void api.jsonStorage.set({
                            enabled: false,
                            status: 'Block monitor is paused. Saved IDs and settings are kept.',
                            targetStatus: 'No voice-channel enforcement is running.',
                        })}
                        style={{ ...buttonStyle, backgroundColor: '#4E5058' }}
                    >
                        <Text style={buttonText}>Pause Block</Text>
                    </Pressable>

                    <Text style={{ color: textColor, fontSize: 17, fontWeight: '800', marginTop: 16 }}>Automatic moderation actions</Text>
                    <Text style={{ color: muted, fontSize: 12, lineHeight: 18 }}>
                        Each action is independent. Block checks the relevant permission before sending that action and waits for Discord voice-state confirmation.
                    </Text>

                    {([
                        ['mute', 'Server Mute', 'Keep a blocked user server-muted while they are in your current voice channel.'],
                        ['deafen', 'Server Deafen', 'Keep a blocked user server-deafened while they are in your current voice channel.'],
                        ['disconnect', 'Disconnect', 'Disconnect a blocked user from your current voice channel.'],
                    ] as const).map(([key, title, description]) => (
                        <Pressable
                            key={key}
                            onPress={() => toggleMonitor(key)}
                            accessibilityRole="switch"
                            accessibilityState={{ checked: settings[key] !== false }}
                            style={{
                                flexDirection: 'row',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                padding: 13,
                                borderRadius: 10,
                                marginTop: 6,
                                backgroundColor: 'rgba(128,128,128,0.13)',
                                borderWidth: 1,
                                borderColor: settings[key] !== false ? 'rgba(88,101,242,0.65)' : 'rgba(255,255,255,0.08)',
                            }}
                        >
                            <View style={{ flex: 1, gap: 3, paddingRight: 12 }}>
                                <Text style={buttonText}>{title}</Text>
                                <Text style={{ color: muted, fontSize: 12, lineHeight: 17 }}>{description}</Text>
                            </View>
                            <View style={{
                                paddingHorizontal: 12,
                                paddingVertical: 6,
                                borderRadius: 20,
                                backgroundColor: settings[key] !== false ? '#5865F2' : '#4E5058',
                            }}>
                                <Text style={{ color: '#FFFFFF', fontSize: 12, fontWeight: '800' }}>
                                    {settings[key] !== false ? 'ON' : 'OFF'}
                                </Text>
                            </View>
                        </Pressable>
                    ))}

                    <View style={{
                        marginTop: 18,
                        padding: 14,
                        borderRadius: 12,
                        backgroundColor: 'rgba(128,128,128,0.13)',
                        borderWidth: 1,
                        borderColor: 'rgba(255,255,255,0.10)',
                        gap: 7,
                    }}>
                        <Text style={{ color: textColor, fontSize: 16, fontWeight: '800' }}>Block status</Text>
                        <Text style={{ color: settings.enabled ? '#57F287' : muted, fontSize: 13, fontWeight: '800' }}>
                            {settings.enabled ? 'BLOCK ENABLED' : 'PAUSED'}
                        </Text>
                        <Text style={{ color: muted, fontSize: 13, lineHeight: 19 }}>
                            {String(settings.status ?? 'Block is paused.')}
                        </Text>
                        <View style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.12)', marginVertical: 4 }} />
                        <Text style={{ color: textColor, fontSize: 14, fontWeight: '700' }}>Target details</Text>
                        <Text selectable style={{ color: muted, fontSize: 12, lineHeight: 18 }}>
                            {String(settings.targetStatus ?? 'No voice-channel enforcement is running.')}
                        </Text>
                    </View>

                    <Text style={{ color: muted, fontSize: 12, lineHeight: 18, marginTop: 8 }}>
                        Discord remains authoritative. A request is not reported as complete until the resulting voice state confirms it. Discord permission failures and rate limits are handled separately for each action.
                    </Text>
                </View>
            </ScrollView>
        )
    },
})
