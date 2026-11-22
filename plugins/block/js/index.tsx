import React from 'react'
import { ToastActionCreators } from '@valenced/discord/actions'
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { getStore, onAnyFluxEventDispatched } from '@valenced/discord/flux'
import { getModules } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import {
    getDiscordErrorMessage,
    getNewVoiceEntrants,
    hasPermission,
    parseCommandIds,
    parseTargetIds,
    resolveCurrentVoiceInfo,
    resolveUserVoiceInfo,
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
const ACTION_SPACING_MS = 250

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

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
        const running = new Set<string>()
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

        const toast = (message: string, variant: 'default' | 'success' | 'critical' = 'default') => {
            try {
                ToastActionCreators.open('BLOCK_COMMAND', { text: '[Block] ' + message, variant })
            } catch (error) {
                logger?.error?.('[Block] Toast failed', error)
            }
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

        const action = async (userId: string, guildId: string, channelId: string, channel: any) => {
            const settings = jsonStorage.cache ?? DEFAULT_SETTINGS
            const ownId = currentUserId()
            if (!ownId || !permissionStore || !http || !channel) return
            const own = resolveCurrentVoiceInfo(ownId, voiceStore, channelStore)
            const target = resolveUserVoiceInfo(userId, guildId, voiceStore, channelStore)
            if (own.guildId !== guildId || own.channelId !== channelId ||
                target.guildId !== guildId || target.channelId !== channelId) return

            const can = (permission: bigint) => hasPermission(permissionStore, permission, channel)
            const results: string[] = []

            const apply = async (enabled: boolean, permitted: boolean, label: string, body: Record<string, unknown>) => {
                if (!enabled) return
                if (!permitted) {
                    results.push(label + ': missing permission')
                    return
                }
                const currentOwn = resolveCurrentVoiceInfo(ownId, voiceStore, channelStore)
                const currentTarget = voiceInfo(userId, guildId)
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
                        throw new Error(getDiscordErrorMessage(response) || ('HTTP ' + responseStatus))
                    }
                    results.push(label + ': requested')
                } catch (error: any) {
                    const detail = getDiscordErrorMessage(error)
                    results.push(label + ': rejected' + (detail ? ' (' + detail + ')' : ''))
                    logger?.warn?.('[Block] Discord rejected ' + label, { userId, guildId, error })
                }
                await delay(ACTION_SPACING_MS)
            }

            await apply(settings.mute !== false, can(MUTE_MEMBERS), 'Server mute', { mute: true })
            await apply(settings.deafen !== false, can(DEAFEN_MEMBERS), 'Server deafen', { deaf: true })
            await apply(settings.disconnect !== false, can(MOVE_MEMBERS), 'Disconnect', { channel_id: null })

            if (results.length) {
                const summary = userId + ': ' + results.join('; ')
                status(summary)
                toast(summary, results.some(item => item.includes('rejected')) ? 'critical' : 'default')
            } else status('All Block actions are disabled in Configure.')
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
                    lastTargetsSignature = signature
                }
                const ownId = currentUserId()
                if (!ownId) { status('Waiting for your Discord account to load.'); return }
                const own = resolveCurrentVoiceInfo(ownId, voiceStore, channelStore)
                if (!own.guildId || !own.channelId) {
                    presence.clear()
                    status('Armed. Waiting for you to join voice; protection resumes automatically.')
                    return
                }
                const channel = own.channel ?? channelStore?.getChannel?.(own.channelId)
                if (!channel) {
                    status('Your current voice channel is not available in Discord yet.')
                    return
                }
                if (!permissionStore) {
                    status('Waiting for Discord PermissionStore to load.')
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
                for (const id of entrants) {
                    const key = own.guildId + ':' + own.channelId + ':' + id
                    if (running.has(key)) continue
                    running.add(key)
                    try { await action(id, own.guildId, own.channelId, channel) }
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
                            toast(parsed.error, 'critical')
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
                        toast('Protection enabled for ' + ids.length + ' user(s).', 'success')
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
                        toast('Protection paused.', 'success')
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
            },
        )
    },

    SettingsComponent({ api }) {
            const settings = api.jsonStorage.use() ?? DEFAULT_SETTINGS
            const [draft, setDraft] = React.useState(String(settings.userIds ?? ''))
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
                    ToastActionCreators.open('BLOCK_SETTINGS', {
                        text: parsed.invalid.length
                            ? 'Fix invalid Discord user ID(s) before saving.'
                            : parsed.overflow
                                ? 'You can save up to ' + MAX_TARGETS + ' unique user IDs.'
                                : 'Enter at least one valid Discord user ID.',
                        variant: 'critical',
                    })
                    return
                }
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
                        <Text style={{ color: muted, fontSize: 14 }}>
                            Block watches your active voice channel in any server. When a configured user joins the same channel, it attempts the enabled moderation actions that your account is permitted to use. It pauses when you leave voice and resumes when you join again.
                        </Text>
                        <TextInput value={draft} onChangeText={setDraft}
                            placeholder={'123456789012345678\n234567890123456789'}
                            placeholderTextColor="#72767D" multiline autoCapitalize="none"
                            autoCorrect={false} keyboardType="numeric" textAlignVertical="top"
                            style={{ minHeight: 120, padding: 12, borderRadius: 8, color: '#F2F3F5', backgroundColor: 'rgba(128,128,128,0.16)', fontSize: 15 }} />
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
                        <Text style={{ color: '#F2F3F5', fontSize: 16, fontWeight: '700', marginTop: 12 }}>Configure actions</Text>
                        {(['mute', 'deafen', 'disconnect'] as const).map((key) => (
                            <Pressable key={key} onPress={() => void api.jsonStorage.set({ [key]: !settings[key] })}
                                style={{ ...button, backgroundColor: '#4E5058' }}>
                                <Text style={text}>{key === 'mute' ? 'Server mute' : key === 'deafen' ? 'Server deafen' : 'Disconnect'}: {settings[key] ? 'ON' : 'OFF'}</Text>
                            </Pressable>
                        ))}
                        <Text style={{ color: '#F2F3F5', fontSize: 16, fontWeight: '700', marginTop: 10 }}>Status</Text>
                        <Text style={{ color: muted, fontSize: 14 }}>{settings.enabled ? 'Enabled' : 'Paused'} · {String(settings.status ?? 'Block is stopped.')}</Text>
                        <Text style={{ color: muted, fontSize: 12, marginTop: 8 }}>
                            Server mute and deafen require their respective Discord permissions. Disconnect requires Move Members. Discord role hierarchy and server rules can still reject an action. Disconnect does not permanently ban someone from a server.
                        </Text>
                    </View>
                </ScrollView>
            )
    },
})
