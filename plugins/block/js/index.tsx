import React from 'react'
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { getStore, onAnyFluxEventDispatched } from '@valenced/discord/flux'
import { getModules } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import {
    getDiscordErrorMessage,
    getDiscordRetryAfterMs,
    getNewVoiceEntrants,
    hasPermission,
    parseCommandIds,
    parseTargetIds,
    resolveCurrentVoiceInfo,
    resolveUserVoiceInfo,
    resolveVoiceState,
    needsVoiceEnforcement,
} from './helpers'

interface BlockSettings {
    userIds: string
    enabled: boolean
    mute: boolean
    deafen: boolean
    disconnect: boolean
    status: string
}

const DEFAULT_SETTINGS: BlockSettings = {
    userIds: '',
    enabled: false,
    mute: true,
    deafen: true,
    disconnect: true,
    status: 'Block is stopped.',
}

const MAX_TARGETS = 20

const POLL_INTERVAL_MS = 500

const MUTE_MEMBERS = 1n << 22n
const DEAFEN_MEMBERS = 1n << 23n
const MOVE_MEMBERS = 1n << 24n

export default plugin<{ jsonStorage: BlockSettings }>({
    jsonStorage: { load: true, default: DEFAULT_SETTINGS },

    start(api) {
        const { cleanup, jsonStorage, logger } = api
        let stopped = false
        let timer: ReturnType<typeof setTimeout> | null = null
        let poll: ReturnType<typeof setInterval> | null = null
        let checking = false
        let checkAgain = false
        let userStore: any = null
        let voiceStore: any = null
        let channelStore: any = null
        let permissionStore: any = null
        let http: any = null
        let lastStatus = ''
        const presence = new Map<string, boolean>()
        let lastTargetsSignature = ''
        let lastVoiceSession = ''
        const running = new Set<string>()
        const retryAt = new Map<string, number>()
        const commands: Array<() => void> = []

        const status = (message: string) => {
            if (lastStatus === message) return
            lastStatus = message
            try {
                void jsonStorage.set({ status: message })
            } catch (error) {
                logger?.error?.('[Block] Could not save status', error)
            }
            logger?.log?.('[Block]', message)
        }

        const currentUserId = (): string | null => {
            try {
                const id = userStore?.getCurrentUser?.()?.id
                return id ? String(id) : null
            } catch { return null }
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

        const action = async (userId: string, guildId: string, channelId: string, channel: any, isEntry = true) => {
            const settings = jsonStorage.cache ?? DEFAULT_SETTINGS
            const ownId = currentUserId()
            if (!ownId || !http || !channel) return
            const own = resolveCurrentVoiceInfo(ownId, voiceStore, channelStore)
            const target = resolveUserVoiceInfo(userId, guildId, voiceStore, channelStore)
            if (own.guildId !== guildId || own.channelId !== channelId ||
                target.guildId !== guildId || target.channelId !== channelId) return

            const results: string[] = []
            const apply = async (
                enabled: boolean,
                permission: bigint,
                label: string,
                body: Record<string, unknown>,
                shouldRun: boolean,
                actionName: string,
            ) => {
                if (!enabled || !shouldRun) return
                const attemptKey = guildId + ':' + channelId + ':' + userId + ':' + actionName
                const now = Date.now()
                if (now < (retryAt.get(attemptKey) ?? 0)) return
                const localPermissionCheck = hasPermission(permissionStore, permission, channel)
                const currentOwn = resolveCurrentVoiceInfo(ownId, voiceStore, channelStore)
                const currentTarget = resolveUserVoiceInfo(userId, guildId, voiceStore, channelStore)
                if (currentOwn.guildId !== guildId || currentOwn.channelId !== channelId ||
                    currentTarget.guildId !== guildId || currentTarget.channelId !== channelId) {
                    results.push(label + ': skipped; voice session changed')
                    return
                }
                try {
                    const response = await http.patch({
                        url: '/guilds/' + guildId + '/members/' + userId,
                        body,
                    })
                    const responseStatus = Number(response?.status ?? 0)
                    if (response?.ok === false || responseStatus >= 400) {
                        const rejection: any = new Error(getDiscordErrorMessage(response) || ('HTTP ' + responseStatus))
                        rejection.response = response
                        throw rejection
                    }
                    retryAt.delete(attemptKey)
                    results.push(label + ': accepted by Discord')
                } catch (error: any) {
                    const retryAfterMs = getDiscordRetryAfterMs(error)
                    if (retryAfterMs > 0) retryAt.set(attemptKey, Date.now() + retryAfterMs)
                    else retryAt.delete(attemptKey)
                    const detail = getDiscordErrorMessage(error)
                    const localNote = permissionStore && !localPermissionCheck
                        ? ' (the local permission check was negative too)'
                        : ''
                    results.push(label + ': rejected' + (detail ? ' (' + detail + ')' : '') + localNote)
                    logger?.warn?.('[Block] Discord rejected ' + label, { userId, guildId, error })
                }
            }

            const currentState = resolveVoiceState(userId, guildId, voiceStore)
            await apply(settings.mute !== false, MUTE_MEMBERS, 'Server mute', { mute: true }, currentState?.mute !== true, 'mute')
            await apply(settings.deafen !== false, DEAFEN_MEMBERS, 'Server deafen', { deaf: true }, currentState?.deaf !== true, 'deafen')
            await apply(settings.disconnect !== false, MOVE_MEMBERS, 'Disconnect', { channel_id: null }, isEntry, 'disconnect')

            if (results.length) {
                const summary = userId + ': ' + results.join('; ')
                status(summary)
            }
        }

        async function reconcile() {
            if (stopped) return
            if (checking) { checkAgain = true; return }
            checking = true
            try {
                const settings = jsonStorage.cache ?? DEFAULT_SETTINGS
                if (!settings.enabled) {
                    presence.clear()
                    lastTargetsSignature = ''
                    lastVoiceSession = ''
                    retryAt.clear()
                    return
                }

                const parsed = parseTargetIds(settings.userIds, MAX_TARGETS)
                const ids = parsed.ids
                if (parsed.invalid.length) {
                    status('Invalid saved ID(s): ' + parsed.invalid.slice(0, 3).join(', ') + '. Fix them in Configure.')
                    return
                }
                if (parsed.overflow) {
                    status('Only the first ' + MAX_TARGETS + ' unique valid IDs can be watched.')
                }
                if (!ids.length) { status('Add valid user IDs in Configure or use /block.'); return }
                const signature = ids.join(':')
                if (signature !== lastTargetsSignature) {
                    presence.clear()
                    retryAt.clear()
                    retryAt.clear()
                    lastTargetsSignature = signature
                }
                const ownId = currentUserId()
                if (!ownId) { status('Waiting for your Discord account to load.'); return }
                const own = resolveCurrentVoiceInfo(ownId, voiceStore, channelStore)
                if (!own.guildId || !own.channelId) {
                    presence.clear()
                    lastVoiceSession = ''
                    retryAt.clear()
                    status('Armed. Waiting for you to join voice; protection resumes automatically.')
                    return
                }
                const voiceSession = own.guildId + ':' + own.channelId
                if (voiceSession !== lastVoiceSession) {
                    presence.clear()
                    retryAt.clear()
                    retryAt.clear()
                    lastVoiceSession = voiceSession
                }
                const channel = own.channel ?? channelStore?.getChannel?.(own.channelId)
                if (!channel) {
                    status('Your current voice channel is not available in Discord yet.')
                    return
                }
                if (!http) {
                    status('Waiting for Discord HTTP module (HTTP.patch) to load.')
                    return
                }

                const watchIds = ids.filter(id => id !== ownId)
                const entrants = getNewVoiceEntrants(
                    watchIds,
                    own.guildId,
                    own.channelId,
                    presence,
                    id => resolveUserVoiceInfo(id, own.guildId, voiceStore, channelStore),
                )
                const entrantSet = new Set(entrants)
                for (const id of watchIds) {
                    const target = resolveUserVoiceInfo(id, own.guildId, voiceStore, channelStore)
                    if (target.guildId !== own.guildId || target.channelId !== own.channelId) continue
                    const key = own.guildId + ':' + own.channelId + ':' + id
                    if (running.has(key)) continue
                    const state = resolveVoiceState(id, own.guildId, voiceStore)
                    const needsEnforcement = needsVoiceEnforcement(
                        state,
                        settings.mute !== false,
                        settings.deafen !== false,
                    )
                    if (!entrantSet.has(id) && !needsEnforcement) continue
                    running.add(key)
                    try { await action(id, own.guildId, own.channelId, channel, entrantSet.has(id)) }
                    finally { running.delete(key) }
                }
                if (!entrants.length && String(jsonStorage.cache?.status ?? '').startsWith('Armed')) {
                    status('Watching ' + watchIds.length + ' configured user(s) in your current voice channel.')
                }
            } catch (error: any) {
                logger?.error?.('[Block] Protection check failed', error)
                status('Block check failed. See Debug Logs.')
            } finally {
                checking = false
                if (checkAgain) { checkAgain = false; schedule(true) }
            }
        }

        try {
            const registry = (api as any).commands?.commands
            if (typeof registry?.registerCommand !== 'function') {
                logger?.warn?.("[Block] Coco's Command Lib unavailable; use Configure instead.")
            } else {
                commands.push(registry.registerCommand({
                    name: 'block',
                    displayName: 'block',
                    description: 'Enable voice protection for selected user IDs',
                    displayDescription: 'Watch your current voice channel for selected users',
                    applicationId: '-1',
                    inputType: 1,
                    type: 1,
                    shouldHide: () => false,
                    options: Array.from({ length: MAX_TARGETS }, (_, index) => ({
                        name: 'id' + (index + 1),
                        displayName: 'id' + (index + 1),
                        description: 'Discord user ID ' + (index + 1),
                        displayDescription: 'Discord user ID to watch',
                        type: 3,
                        required: index === 0,
                    })),
                    execute: async (args: any[]) => {
                        const parsed = parseCommandIds(args, MAX_TARGETS)
                        if (parsed.error) {
                            status(parsed.error)
                            return
                        }
                        const ids = parsed.ids
                        presence.clear()
                        await jsonStorage.set({
                            userIds: ids.join('\n'),
                            enabled: true,
                            status: 'Armed. Waiting for your active voice channel.',
                        })
                        status('Armed. Waiting for your active voice channel.')
                        schedule(true)
                    },
                }))
                commands.push(registry.registerCommand({
                    name: 'unblock',
                    displayName: 'unblock',
                    description: 'Pause Block voice protection',
                    displayDescription: 'Pause Block voice protection',
                    applicationId: '-1',
                    inputType: 1,
                    type: 1,
                    shouldHide: () => false,
                    execute: async () => {
                        presence.clear()
                        await jsonStorage.set({ enabled: false, status: 'Block is paused. Saved IDs are kept.' })
                        status('Block is paused. Saved IDs are kept.')
                    },
                }))
            }
        } catch (error) {
            logger?.error?.('[Block] Could not register commands', error)
        }

        const unUser = getStore('UserStore', (store: any) => { userStore = store; schedule(true) })
        const unVoice = getStore('VoiceStateStore', (store: any) => { voiceStore = store; schedule(true) })
        const unChannel = getStore('ChannelStore', (store: any) => { channelStore = store; schedule(true) })
        const unPermission = getStore('PermissionStore', (store: any) => { permissionStore = store; schedule(true) })
        const unHttp = getModules(withProps('HTTP', 'get', 'patch'), (module: any) => {
            if (module?.HTTP && typeof module.HTTP.patch === 'function') {
                http = module.HTTP
                schedule(true)
            }
        })
        const unFlux = onAnyFluxEventDispatched((payload: any) => {
            const type = String(payload?.type ?? '')
            if (type.includes('VOICE_STATE') || type.includes('CHANNEL_UPDATE') ||
                type.includes('GUILD_ROLE_UPDATE') || type.includes('GUILD_MEMBER_UPDATE')) schedule(true)
            return payload
        })

        poll = setInterval(() => schedule(false), POLL_INTERVAL_MS)
        schedule(true)

        cleanup(
            unUser, unVoice, unChannel, unPermission, unHttp, unFlux, ...commands,
            () => {
                stopped = true
                if (timer) clearTimeout(timer)
                if (poll) clearInterval(poll)
                presence.clear()
                running.clear()
                retryAt.clear()
                lastVoiceSession = ''
            },
        )
    },

    SettingsComponent({ api }) {
            const settings = api.jsonStorage.use() ?? DEFAULT_SETTINGS
            const [draft, setDraft] = React.useState(String(settings.userIds ?? ''))
            const [validationError, setValidationError] = React.useState('')
            React.useEffect(() => setDraft(String(settings.userIds ?? '')), [settings.userIds])
            const button = {
                paddingVertical: 12, paddingHorizontal: 16, borderRadius: 8,
                alignItems: 'center' as const, marginTop: 10,
            }
            const text = { color: '#F2F3F5', fontSize: 15, fontWeight: '600' as const }
            const muted = '#B5BAC1'
            const saveDraft = (enable: boolean) => {
                const parsed = parseTargetIds(draft, MAX_TARGETS)
                if (parsed.invalid.length || parsed.overflow || parsed.ids.length === 0) {
                    setValidationError(parsed.invalid.length
                        ? 'Some IDs are invalid. Use numeric Discord user IDs.'
                        : parsed.overflow
                            ? 'You can save up to ' + MAX_TARGETS + ' unique IDs.'
                            : 'Add at least one user ID.')
                    return
                }
                setValidationError('')
                const normalized = parsed.ids.join('\n')
                setDraft(normalized)
                void api.jsonStorage.set({
                    userIds: normalized,
                    ...(enable ? {
                        enabled: true,
                        status: 'Armed. Waiting for your active voice channel.',
                    } : {}),
                })
            }
            return (
                <ScrollView contentContainerStyle={{ padding: 16 }}>
                    <View style={{ gap: 8 }}>
                        <Text style={{ color: '#F2F3F5', fontSize: 21, fontWeight: '700' }}>Block</Text>
                        <Text style={{ color: muted, fontSize: 14, lineHeight: 20 }}>
                            Protect your current voice channel across servers. Block watches the IDs below and keeps enabled actions enforced while they remain in your channel. Protection pauses when you leave voice and resumes when you join again.
                        </Text>
                        <Text style={{ color: '#F2F3F5', fontSize: 15, fontWeight: '700', marginTop: 14 }}>Watched users</Text>
                        <Text style={{ color: muted, fontSize: 12 }}>Add up to 20 Discord user IDs, one per line or separated by commas.</Text>
                        <TextInput value={draft} onChangeText={setDraft}
                            placeholder={'123456789012345678\n234567890123456789'}
                            placeholderTextColor="#72767D" multiline autoCapitalize="none"
                            autoCorrect={false} keyboardType="numeric" textAlignVertical="top"
                            style={{ minHeight: 120, padding: 14, borderRadius: 12, color: '#F2F3F5', backgroundColor: 'rgba(128,128,128,0.16)', fontSize: 15, borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)' }} />
                        {!!validationError && <Text style={{ color: '#ED4245', fontSize: 13 }}>{validationError}</Text>}
                        <Pressable onPress={() => saveDraft(false)}
                            style={{ ...button, backgroundColor: '#4E5058' }}>
                            <Text style={text}>Save IDs</Text>
                        </Pressable>
                        <Pressable onPress={() => saveDraft(true)} style={{ ...button, backgroundColor: '#5865F2' }}>
                            <Text style={text}>Enable Block</Text>
                        </Pressable>
                        <Pressable onPress={() => {
                            void api.jsonStorage.set({ enabled: false, status: 'Block is paused. Saved IDs are kept.' })
                        }} style={{ ...button, backgroundColor: '#4E5058' }}>
                            <Text style={text}>Pause Block</Text>
                        </Pressable>
                        <Text style={{ color: '#F2F3F5', fontSize: 17, fontWeight: '700', marginTop: 18 }}>Moderation actions</Text>
                        <Text style={{ color: muted, fontSize: 12 }}>Each action is independent and only works when your Discord account has the required permission.</Text>
                        {(['mute', 'deafen', 'disconnect'] as const).map((key) => (
                            <Pressable key={key} onPress={() => void api.jsonStorage.set({ [key]: !settings[key] })}
                                style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 14, borderRadius: 12, marginTop: 8, backgroundColor: 'rgba(128,128,128,0.13)', borderWidth: 1, borderColor: settings[key] ? 'rgba(88,101,242,0.65)' : 'rgba(255,255,255,0.08)' }}>
                                <View style={{ flex: 1, gap: 3 }}>
                                    <Text style={text}>{key === 'mute' ? 'Server mute' : key === 'deafen' ? 'Server deafen' : 'Disconnect'}</Text>
                                    <Text style={{ color: muted, fontSize: 12 }}>{key === 'mute' ? 'Re-mute if they unmute themselves' : key === 'deafen' ? 'Re-deafen if they undeafen themselves' : 'Disconnect when they enter your voice channel'}</Text>
                                </View>
                                <View style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, backgroundColor: settings[key] ? '#5865F2' : '#4E5058' }}>
                                    <Text style={{ color: '#FFFFFF', fontSize: 12, fontWeight: '700' }}>{settings[key] ? 'ON' : 'OFF'}</Text>
                                </View>
                            </Pressable>
                        ))}
                        <View style={{ marginTop: 18, padding: 14, borderRadius: 12, backgroundColor: 'rgba(128,128,128,0.13)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', gap: 6 }}>
                            <Text style={{ color: '#F2F3F5', fontSize: 15, fontWeight: '700' }}>Protection status</Text>
                            <Text style={{ color: settings.enabled ? '#57F287' : muted, fontSize: 13, fontWeight: '700' }}>{settings.enabled ? 'ACTIVE' : 'PAUSED'}</Text>
                            <Text style={{ color: muted, fontSize: 13, lineHeight: 19 }}>{String(settings.status ?? 'Block is stopped.')}</Text>
                        </View>
                        <Text style={{ color: muted, fontSize: 12, marginTop: 8 }}>
                            Server mute and deafen require their respective Discord permissions. Disconnect requires Move Members. Discord role hierarchy and server rules can still reject an action. Disconnect does not permanently ban someone from a server.
                        </Text>
                    </View>
                </ScrollView>
            )
    },
})
