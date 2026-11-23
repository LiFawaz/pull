import React from 'react'
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { getStore, onAnyFluxEventDispatched } from '@valenced/discord/flux'
import {
    getNewVoiceEntrants,
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
    status: 'Block monitor is paused.',
    targetStatus: 'No voice monitoring is running.',
}

const MAX_TARGETS = 20
const POLL_INTERVAL_MS = 1000
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

        let lastStatus = ''
        let lastTargetStatus = ''
        let lastVoiceSession = ''
        const presence = new Map<string, boolean>()
        const commandUnsubscribers: Array<() => void> = []

        const saveStatus = (message: string, details: string) => {
            if (lastStatus === message && lastTargetStatus === details) return
            lastStatus = message
            lastTargetStatus = details

            try {
                const result = jsonStorage.set({
                    status: message,
                    targetStatus: details,
                })
                Promise.resolve(result).catch((error: any) => {
                    logger?.error?.('[Block] Could not save monitor status', error)
                })
            } catch (error) {
                logger?.error?.('[Block] Could not save monitor status', error)
            }

            logger?.log?.('[Block]', message, details)
        }

        const currentUserId = (): string | null => {
            try {
                const id = userStore?.getCurrentUser?.()?.id
                return id == null ? null : String(id)
            } catch (error) {
                logger?.warn?.('[Block] Could not read the current user', error)
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

        async function reconcile() {
            if (stopped) return
            if (checking) {
                checkAgain = true
                return
            }

            checking = true
            try {
                const settings = jsonStorage.cache ?? DEFAULT_SETTINGS

                if (!settings.enabled) {
                    presence.clear()
                    lastVoiceSession = ''
                    saveStatus(
                        'Block monitor is paused. Saved IDs and settings are kept.',
                        'Enable the monitor from Configure or use /block to start watching.',
                    )
                    return
                }

                const parsed = parseTargetIds(settings.userIds, MAX_TARGETS)
                if (parsed.invalid.length) {
                    saveStatus(
                        'Invalid saved user ID(s).',
                        'Fix these IDs in Configure: ' + parsed.invalid.slice(0, 5).join(', '),
                    )
                    return
                }
                if (parsed.overflow) {
                    saveStatus(
                        'Too many saved targets.',
                        'Block supports up to ' + MAX_TARGETS + ' unique Discord user IDs. Remove the extras in Configure.',
                    )
                    return
                }
                if (!parsed.ids.length) {
                    saveStatus('No targets are configured.', 'Add at least one valid Discord user ID in Configure.')
                    return
                }

                const missingStores: string[] = []
                if (!userStore) missingStores.push('UserStore')
                if (!voiceStore) missingStores.push('VoiceStateStore')
                if (!channelStore) missingStores.push('ChannelStore')
                if (!permissionStore) missingStores.push('PermissionStore')

                if (missingStores.length) {
                    saveStatus(
                        'Waiting for Discord ' + missingStores[0] + '.',
                        'Required stores not ready: ' + missingStores.join(', ') + '.',
                    )
                    return
                }

                const ownId = currentUserId()
                if (!ownId) {
                    saveStatus('Waiting for your Discord account to load.', 'UserStore is ready, but the current account is not available yet.')
                    return
                }

                const own = resolveCurrentVoiceInfo(ownId, voiceStore, channelStore)
                if (!own.guildId || !own.channelId) {
                    presence.clear()
                    lastVoiceSession = ''
                    saveStatus('Waiting for you to join a voice channel.', 'The monitor will resume automatically when your account joins voice.')
                    return
                }

                const voiceSession = own.guildId + ':' + own.channelId
                if (voiceSession !== lastVoiceSession) {
                    presence.clear()
                    lastVoiceSession = voiceSession
                }

                const channel = own.channel ?? channelStore?.getChannel?.(own.channelId) ?? null
                if (!channel) {
                    saveStatus('Waiting for your voice channel to load.', 'Current channel ID: ' + own.channelId)
                    return
                }

                const ids = parsed.ids.filter(id => id !== ownId)
                const entrants = getNewVoiceEntrants(
                    ids,
                    own.guildId,
                    own.channelId,
                    presence,
                    id => resolveUserVoiceInfo(id, own.guildId, voiceStore, channelStore),
                )

                const detected: string[] = []
                for (const id of ids) {
                    const target = resolveUserVoiceInfo(id, own.guildId, voiceStore, channelStore)
                    if (target.guildId !== own.guildId || target.channelId !== own.channelId) continue

                    const state = resolveVoiceState(id, own.guildId, voiceStore)
                    const details: string[] = [id + ': detected in your current voice channel']

                    if (settings.mute !== false) {
                        const actual = state?.mute === true ? 'server-muted' : 'not server-muted'
                        const permission = hasPermission(permissionStore, MUTE_MEMBERS, channel) ? 'locally allowed' : 'locally denied'
                        details.push('Mute state: ' + actual + ' (Mute Members: ' + permission + ')')
                    }

                    if (settings.deafen !== false) {
                        const actual = state?.deaf === true ? 'server-deafened' : 'not server-deafened'
                        const permission = hasPermission(permissionStore, DEAFEN_MEMBERS, channel) ? 'locally allowed' : 'locally denied'
                        details.push('Deafen state: ' + actual + ' (Deafen Members: ' + permission + ')')
                    }

                    if (settings.disconnect !== false) {
                        const permission = hasPermission(permissionStore, MOVE_MEMBERS, channel) ? 'locally allowed' : 'locally denied'
                        details.push('Disconnect permission: ' + permission + '; use Discord controls manually if needed')
                    }

                    detected.push(details.join(' | '))
                }

                const permissionSummary = [
                    settings.mute !== false
                        ? 'Mute Members: ' + (hasPermission(permissionStore, MUTE_MEMBERS, channel) ? 'allowed' : 'not granted')
                        : '',
                    settings.deafen !== false
                        ? 'Deafen Members: ' + (hasPermission(permissionStore, DEAFEN_MEMBERS, channel) ? 'allowed' : 'not granted')
                        : '',
                    settings.disconnect !== false
                        ? 'Move Members: ' + (hasPermission(permissionStore, MOVE_MEMBERS, channel) ? 'allowed' : 'not granted')
                        : '',
                ].filter(Boolean).join(' | ')

                const targetDetails = detected.length
                    ? detected.join('\n\n') + '\n\nPermission check is informational only. Discord remains authoritative.'
                    : 'No configured targets are currently in your voice channel.\n\n' + permissionSummary

                const statusMessage = detected.length
                    ? (entrants.length
                        ? 'Target detected. ' + detected.length + ' configured target(s) are in your channel.'
                        : 'Monitoring ' + ids.length + ' configured target(s). ' + detected.length + ' currently present.')
                    : 'Voice monitor active. Monitoring ' + ids.length + ' configured target(s).'

                saveStatus(
                    statusMessage,
                    targetDetails + '\n\nBlock is monitor-only. It does not send mute, deafen, or disconnect requests.',
                )
            } catch (error: any) {
                const message = error instanceof Error ? error.message : String(error ?? 'Unknown error')
                logger?.error?.('[Block] Monitor reconciliation failed', {
                    message,
                    stack: error?.stack,
                    error,
                })
                saveStatus('Voice monitor check failed.', message + '. See Block debug logs.')
            } finally {
                checking = false
                if (checkAgain) {
                    checkAgain = false
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
                    description: 'Start monitoring selected user IDs in your current voice channel',
                    displayDescription: 'Monitor up to 20 Discord user IDs in your current voice channel',
                    applicationId: '-1',
                    inputType: 1,
                    type: 1,
                    shouldHide: () => false,
                    options: Array.from({ length: MAX_TARGETS }, (_, index) => ({
                        name: 'id' + (index + 1),
                        displayName: 'id' + (index + 1),
                        description: 'Discord user ID ' + (index + 1),
                        displayDescription: 'Discord user ID to monitor',
                        type: 3,
                        required: index === 0,
                    })),
                    execute: async (args: any[]) => {
                        const parsedCommand = parseCommandIds(args, MAX_TARGETS)
                        if (parsedCommand.error) {
                            saveStatus('Could not start the monitor.', parsedCommand.error)
                            return
                        }

                        presence.clear()
                        await jsonStorage.set({
                            userIds: parsedCommand.ids.join('\n'),
                            enabled: true,
                            status: 'Voice monitor is starting.',
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
                    description: 'Pause the Block voice monitor without deleting saved IDs',
                    displayDescription: 'Pause Block monitoring and keep saved settings',
                    applicationId: '-1',
                    inputType: 1,
                    type: 1,
                    shouldHide: () => false,
                    execute: async () => {
                        presence.clear()
                        await jsonStorage.set({
                            enabled: false,
                            status: 'Block monitor is paused. Saved IDs and settings are kept.',
                            targetStatus: 'No voice monitoring is running.',
                        })
                        lastStatus = ''
                        lastTargetStatus = ''
                        schedule(true)
                    },
                }))
            }
        } catch (error) {
            logger?.error?.('[Block] Could not register commands', error)
            saveStatus('Slash commands could not be registered.', "Check that Coco's Command Lib is installed and enabled.")
        }

        const unUser = getStore('UserStore', (store: any) => {
            userStore = store
            schedule(true)
        })
        const unVoice = getStore('VoiceStateStore', (store: any) => {
            voiceStore = store
            schedule(true)
        })
        const unChannel = getStore('ChannelStore', (store: any) => {
            channelStore = store
            schedule(true)
        })
        const unPermission = getStore('PermissionStore', (store: any) => {
            permissionStore = store
            schedule(true)
        })

        const unFlux = onAnyFluxEventDispatched((payload: any) => {
            const type = String(payload?.type ?? '')
            if (
                type.includes('VOICE_STATE') ||
                type.includes('CHANNEL_UPDATE') ||
                type.includes('GUILD_ROLE_UPDATE') ||
                type.includes('GUILD_MEMBER_UPDATE')
            ) {
                schedule(true)
            }
            return payload
        })

        poll = setInterval(() => schedule(false), POLL_INTERVAL_MS)
        schedule(true)

        cleanup(
            unUser,
            unVoice,
            unChannel,
            unPermission,
            unFlux,
            ...commandUnsubscribers,
            () => {
                stopped = true
                if (timer) clearTimeout(timer)
                if (poll) clearInterval(poll)
                presence.clear()
                lastVoiceSession = ''
                userStore = null
                voiceStore = null
                channelStore = null
                permissionStore = null
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
                    status: 'Voice monitor is starting.',
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
                        Monitor selected Discord user IDs in the voice channel you are currently connected to.
                        Monitoring pauses when you leave voice and resumes when you join another channel.
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
                        <Text style={buttonText}>Enable monitor</Text>
                    </Pressable>
                    <Pressable
                        onPress={() => void api.jsonStorage.set({
                            enabled: false,
                            status: 'Block monitor is paused. Saved IDs and settings are kept.',
                            targetStatus: 'No voice monitoring is running.',
                        })}
                        style={{ ...buttonStyle, backgroundColor: '#4E5058' }}
                    >
                        <Text style={buttonText}>Pause monitor</Text>
                    </Pressable>

                    <Text style={{ color: textColor, fontSize: 17, fontWeight: '800', marginTop: 16 }}>Voice-state checks</Text>
                    <Text style={{ color: muted, fontSize: 12, lineHeight: 18 }}>
                        These switches control which state and permission details appear in the monitor. They do not execute moderation actions.
                    </Text>

                    {([
                        ['mute', 'Track server mute', 'Show whether a detected user is server-muted and whether Mute Members is locally available.'],
                        ['deafen', 'Track server deafen', 'Show whether a detected user is server-deafened and whether Deafen Members is locally available.'],
                        ['disconnect', 'Track disconnect eligibility', 'Show whether Move Members is locally available for the current voice channel.'],
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
                        <Text style={{ color: textColor, fontSize: 16, fontWeight: '800' }}>Monitor status</Text>
                        <Text style={{ color: settings.enabled ? '#57F287' : muted, fontSize: 13, fontWeight: '800' }}>
                            {settings.enabled ? 'MONITOR ENABLED' : 'PAUSED'}
                        </Text>
                        <Text style={{ color: muted, fontSize: 13, lineHeight: 19 }}>
                            {String(settings.status ?? 'Block monitor is paused.')}
                        </Text>
                        <View style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.12)', marginVertical: 4 }} />
                        <Text style={{ color: textColor, fontSize: 14, fontWeight: '700' }}>Target details</Text>
                        <Text selectable style={{ color: muted, fontSize: 12, lineHeight: 18 }}>
                            {String(settings.targetStatus ?? 'No voice monitoring is running.')}
                        </Text>
                    </View>

                    <Text style={{ color: muted, fontSize: 12, lineHeight: 18, marginTop: 8 }}>
                        Permission results are informational and may not include every server-side restriction. Discord makes the final permission decision. Block does not send moderation HTTP requests; use Discord's built-in voice-channel controls for any moderation action.
                    </Text>
                </View>
            </ScrollView>
        )
    },
})
