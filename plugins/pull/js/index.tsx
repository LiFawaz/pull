import React from 'react'
import { ToastActionCreators } from '@valenced/discord/actions'
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { getStore, onAnyFluxEventDispatched } from '@valenced/discord/flux'
import { getModules } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'

interface PullSettings {
    userIds: string
    enabled: boolean
    status: string
}

const DEFAULT_SETTINGS: PullSettings = {
    userIds: '',
    enabled: false,
    status: 'Pull is stopped.',
}

const MOVE_MEMBERS = 1n << 24n
const MAX_TARGETS = 20
const MOVE_SPACING_MS = 400
const DUPLICATE_COOLDOWN_MS = 800
const HISTORY_WINDOW_MS = 60_000
const MAX_MOVES_PER_TARGET = 10
const TARGET_PAUSE_MS = 30_000
const MAX_MOVES_GLOBAL = 40

function parseTargetIds(value: unknown): { ids: string[]; overflow: boolean } {
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
        ids: ids.slice(0, MAX_TARGETS),
        overflow: ids.length > MAX_TARGETS,
    }
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}



export default plugin<{ jsonStorage: PullSettings }>({
    jsonStorage: {
        load: true,
        default: DEFAULT_SETTINGS,
    },

    start(api) {
        const { cleanup, jsonStorage, logger } = api
        let stopped = false
        let reconcileTimer: ReturnType<typeof setTimeout> | null = null
        let pollTimer: ReturnType<typeof setInterval> | null = null
        let reconciling = false
        let reconcileAgain = false
        let lastStatus = ''
        const moving = new Set<string>()
        const lastMoveAt = new Map<string, number>()
        const moveHistory = new Map<string, number[]>()
        const pausedUntil = new Map<string, number>()
        let globalMoveHistory: number[] = []

        let userStore: any = null
        let voiceStore: any = null
        let channelStore: any = null
        let permissionStore: any = null
        let restApi: any = null

        function status(message: string) {
            if (message === lastStatus) return
            lastStatus = message
            try {
                void jsonStorage.set({ status: message })
            } catch (error) {
                logger?.error?.('Could not save Pull status', error)
            }
            logger?.log?.('[Pull]', message)
        }


        const commandUnsubscribers: Array<() => void> = []

        function commandToast(message: string, variant: 'default' | 'success' | 'critical' = 'default') {
            try {
                ToastActionCreators.open('PULL_COMMAND', {
                    text: `[Pull] ${message}`,
                    variant,
                })
            } catch (error) {
                logger?.error?.('[Pull] Could not show command feedback', error)
            }
        }

        function parseCommandIds(args: any[]): { ids: string[]; error: string | null } {
            const values = (Array.isArray(args) ? args : [])
                .filter((arg: any) => /^id\d+$/.test(String(arg?.name ?? '')))
                .map((arg: any) => String(arg?.value ?? '').trim())
                .filter((value: string) => value.length > 0)

            if (!values.length) {
                return { ids: [], error: 'Enter at least one ID in id1 or another ID field.' }
            }

            if (values.some((id: string) => !/^\d{15,22}$/.test(id))) {
                return { ids: [], error: 'Each ID field must contain a numeric Discord user ID.' }
            }

            const ids = [...new Set(values)]
            if (ids.length > MAX_TARGETS) {
                return { ids: [], error: `You can enter up to ${MAX_TARGETS} different user IDs.` }
            }

            return { ids, error: null }
        }

        function registerPullCommands() {
            try {
                const commandRegistry = (api as any).commands?.commands
                if (typeof commandRegistry?.registerCommand !== 'function') {
                    throw new Error("Coco's Command Lib is unavailable.")
                }

                commandUnsubscribers.push(commandRegistry.registerCommand({
                    name: 'pull',
                    displayName: 'pull',
                    description: 'Move your configured alternate accounts into your current voice channel',
                    displayDescription: 'Move your configured alternate accounts into your current voice channel',
                    applicationId: '-1',
                    inputType: 1,
                    type: 1,
                    shouldHide: () => false,
                    options: Array.from({ length: MAX_TARGETS }, (_, index) => {
                        const name = `id${index + 1}`
                        return {
                            name,
                            displayName: name,
                            description: `Discord user ID ${index + 1}`,
                            displayDescription: `Enter the Discord user ID for account ${index + 1}`,
                            type: 3,
                            required: index === 0,
                        }
                    }),
                    execute: async (args: any[]) => {
                        const parsed = parseCommandIds(args)
                        if (parsed.error) {
                            commandToast(parsed.error, 'critical')
                            return
                        }

                        await jsonStorage.set({
                            userIds: parsed.ids.join('\n'),
                            enabled: true,
                        })
                        status(`Pull is armed for ${parsed.ids.length} configured accounts.`)
                        scheduleReconcile()
                        commandToast(`Pull started for ${parsed.ids.length} accounts.`, 'success')
                    },
                }))

                commandUnsubscribers.push(commandRegistry.registerCommand({
                    name: 'unpull',
                    displayName: 'unpull',
                    description: 'Stop moving your configured alt accounts',
                    displayDescription: 'Stop moving your configured alt accounts',
                    applicationId: '-1',
                    inputType: 1,
                    type: 1,
                    shouldHide: () => false,
                    execute: async () => {
                        await jsonStorage.set({ enabled: false })
                        status('Pull is stopped.')
                        scheduleReconcile()
                        commandToast('All pulling has been stopped.', 'success')
                    },
                }))
            } catch (error) {
                logger?.error?.('[Pull] Could not register slash commands', error)
                status("Slash commands are unavailable. Check that Coco's Command Lib is installed.")
            }
        }

        registerPullCommands()

        function getCurrentUserId(): string | null {
            try {
                const id = userStore?.getCurrentUser?.()?.id
                return id ? String(id) : null
            } catch {
                return null
            }
        }

        function getVoiceInfo(userId: string): {
            channelId: string | null
            guildId: string | null
            channel: any
        } {
            let state: any = null
            let indexedGuildId: string | null = null

            // Discord stores voice states by guild, then user ID. The state
            // itself does not always include guildId, so keep the map key.
            try {
                const all = voiceStore?.getAllVoiceStates?.()
                if (all && typeof all === 'object') {
                    for (const [guildId, members] of Object.entries(all)) {
                        if (!members || typeof members !== 'object') continue
                        const candidate = (members as any)[userId]
                        if (!candidate) continue

                        state = candidate
                        if (guildId !== '@me') indexedGuildId = String(guildId)
                        if (indexedGuildId) break
                    }
                }
            } catch (error) {
                logger?.error?.('[Pull] All voice states lookup failed', error)
            }

            // Fallback for client builds where only the per-user accessor is available.
            if (!state) {
                try {
                    state = voiceStore?.getVoiceStateForUser?.(userId) ?? null
                } catch (error) {
                    logger?.error?.('[Pull] Per-user voice state lookup failed', error)
                }
            }

            if (!state) return { channelId: null, guildId: null, channel: null }

            const rawChannelId = state.channelId ?? state.channel_id
            const channelId = rawChannelId == null ? null : String(rawChannelId)
            if (!channelId) return { channelId: null, guildId: indexedGuildId, channel: null }

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
                channel?.guild_id

            return {
                channelId,
                guildId: rawGuildId == null ? null : String(rawGuildId),
                channel,
            }
        }

        function canMoveBetween(sourceChannel: any, destinationChannel: any): boolean {
            if (!permissionStore || typeof permissionStore.can !== 'function') return false
            if (!sourceChannel || !destinationChannel) return false

            try {
                // The current user is already connected to the destination voice
                // channel, so CONNECT is not an additional requirement here.
                return (
                    permissionStore.can(MOVE_MEMBERS, sourceChannel) === true &&
                    permissionStore.can(MOVE_MEMBERS, destinationChannel) === true
                )
            } catch (error) {
                logger?.error?.('[Pull] Permission check failed', error)
                return false
            }
        }

        function keepRecent(stamps: number[], now: number): number[] {
            return stamps.filter(at => now - at < HISTORY_WINDOW_MS)
        }

        function scheduleReconcile() {
            if (stopped) return
            if (reconcileTimer) clearTimeout(reconcileTimer)
            reconcileTimer = setTimeout(() => {
                reconcileTimer = null
                void reconcile()
            }, 180)
        }

        // getStore is callback-based: stores may not exist yet when the plugin starts.
        const unsubscribeUserStore = getStore('UserStore', (store: any) => {
            userStore = store
            scheduleReconcile()
        })
        const unsubscribeVoiceStore = getStore('VoiceStateStore', (store: any) => {
            voiceStore = store
            scheduleReconcile()
        })
        const unsubscribeChannelStore = getStore('ChannelStore', (store: any) => {
            channelStore = store
            scheduleReconcile()
        })
        const unsubscribePermissionStore = getStore('PermissionStore', (store: any) => {
            permissionStore = store
            scheduleReconcile()
        })

        // Current Discord builds expose authenticated requests through the HTTP module.
        // Subscribe for it as it initializes instead of searching for an obsolete RestAPI export.
        const unsubscribeHttpModule = getModules(
            withProps('HTTP', 'get', 'patch'),
            (module: any) => {
                const http = module?.HTTP
                if (http && typeof http.patch === 'function') {
                    restApi = http
                    logger?.log?.('[Pull] Discord HTTP module is ready.')
                    scheduleReconcile()
                }
            },
        )

        async function reconcile() {
            if (stopped) return
            if (reconciling) {
                reconcileAgain = true
                return
            }

            reconciling = true
            try {
                await runReconcile()
            } catch (error) {
                logger?.error?.('[Pull] Reconciliation failed', error)
                status('Pull could not check voice members. See Valenced debug logs.')
            } finally {
                reconciling = false
                if (reconcileAgain) {
                    reconcileAgain = false
                    scheduleReconcile()
                }
            }
        }

        async function runReconcile() {
            const settings = jsonStorage.cache ?? DEFAULT_SETTINGS
            if (!settings.enabled) {
                status('Pull is stopped.')
                return
            }

            const parsed = parseTargetIds(settings.userIds)
            const targetIds = parsed.ids
            if (!targetIds.length) {
                status('Add at least one valid Discord user ID, then start Pull.')
                return
            }

            const ownId = getCurrentUserId()
            if (!ownId) {
                status('Waiting for your Discord account to load.')
                return
            }

            const destinationInfo = getVoiceInfo(ownId)
            if (!destinationInfo.channelId || !destinationInfo.guildId) {
                status('Pull is armed. Join a voice channel to start pulling your configured accounts.')
                return
            }

            const destinationChannel =
                destinationInfo.channel ??
                channelStore?.getChannel?.(destinationInfo.channelId)

            if (!destinationChannel) {
                status('Your current voice channel is not available in Discord yet.')
                return
            }

            if (!permissionStore) {
                status('Pull is waiting for Discord PermissionStore to load.')
                return
            }
            if (!restApi) {
                status('Pull is waiting for Discord HTTP module (HTTP.patch) to load.')
                return
            }

            const jobs: Array<{
                userId: string
                sourceChannelId: string
                sourceChannel: any
                guildId: string
            }> = []
            let notInVoice = 0
            let otherServer = 0
            let alreadyWithYou = 0
            let permissionBlocked = 0
            let coolingDown = 0
            const now = Date.now()

            for (const userId of targetIds) {
                if (userId === ownId) continue

                const target = getVoiceInfo(userId)
                if (!target.channelId) {
                    notInVoice++
                    continue
                }

                if (!target.guildId || target.guildId !== destinationInfo.guildId) {
                    otherServer++
                    continue
                }

                if (target.channelId === destinationInfo.channelId) {
                    alreadyWithYou++
                    continue
                }

                const sourceChannel =
                    target.channel ??
                    channelStore?.getChannel?.(target.channelId)

                if (!canMoveBetween(sourceChannel, destinationChannel)) {
                    permissionBlocked++
                    continue
                }

                const paused = pausedUntil.get(userId) ?? 0
                const recentUserMoves = keepRecent(moveHistory.get(userId) ?? [], now)
                moveHistory.set(userId, recentUserMoves)

                if (paused > now || now - (lastMoveAt.get(userId) ?? 0) < DUPLICATE_COOLDOWN_MS) {
                    coolingDown++
                    continue
                }

                if (recentUserMoves.length >= MAX_MOVES_PER_TARGET) {
                    pausedUntil.set(userId, now + TARGET_PAUSE_MS)
                    coolingDown++
                    continue
                }

                if (moving.has(userId)) {
                    coolingDown++
                    continue
                }

                jobs.push({
                    userId,
                    sourceChannelId: target.channelId,
                    sourceChannel,
                    guildId: destinationInfo.guildId,
                })
            }

            globalMoveHistory = keepRecent(globalMoveHistory, now)
            if (globalMoveHistory.length >= MAX_MOVES_GLOBAL) {
                status('Pull is paused briefly by its safety limit (40 moves per minute).')
                return
            }

            let moved = 0
            let failed = 0
            let rateLimited = false
            let lastFailure = ''

            for (const job of jobs) {
                if (stopped || !jsonStorage.cache?.enabled) break

                // Do not keep sending moves to an old destination if you switch channels mid-queue.
                const latestDestination = getVoiceInfo(ownId)
                if (latestDestination.channelId !== destinationInfo.channelId) {
                    scheduleReconcile()
                    break
                }

                const latestTarget = getVoiceInfo(job.userId)
                if (
                    latestTarget.channelId !== job.sourceChannelId ||
                    latestTarget.guildId !== job.guildId
                ) {
                    continue
                }

                const latestSourceChannel =
                    latestTarget.channel ??
                    channelStore?.getChannel?.(job.sourceChannelId)

                if (!canMoveBetween(latestSourceChannel, destinationChannel)) {
                    permissionBlocked++
                    continue
                }

                const userMoves = keepRecent(moveHistory.get(job.userId) ?? [], Date.now())
                if (userMoves.length >= MAX_MOVES_PER_TARGET) {
                    pausedUntil.set(job.userId, Date.now() + TARGET_PAUSE_MS)
                    coolingDown++
                    continue
                }

                if (moving.has(job.userId)) continue
                moving.add(job.userId)

                try {
                    const response = await restApi.patch({
                        url: `/guilds/${job.guildId}/members/${job.userId}`,
                        body: { channel_id: destinationInfo.channelId },
                    })
                    const responseStatus = Number(response?.status ?? 0)
                    if (response?.ok === false || responseStatus >= 400) {
                        const requestError: any = new Error(
                            `Discord HTTP PATCH failed with status ${responseStatus || 'unknown'}.`,
                        )
                        requestError.status = responseStatus
                        requestError.body = response?.body
                        throw requestError
                    }

                    const stamp = Date.now()
                    moveHistory.set(job.userId, [...userMoves, stamp])
                    globalMoveHistory.push(stamp)
                    lastMoveAt.set(job.userId, stamp)
                    moved++
                } catch (error: any) {
                    failed++
                    const statusCode = Number(error?.status ?? 0)
                    const code = Number(error?.body?.code ?? 0)

                    if (statusCode === 429) {
                        rateLimited = true
                        logger?.warn?.('[Pull] Discord rate-limited a voice move', error)
                        break
                    }

                    if (statusCode === 403 || code === 50013) {
                        permissionBlocked++
                    }

                    lastFailure = statusCode
                        ? `HTTP ${statusCode}${code ? ` (Discord code ${code})` : ''}`
                        : String(error?.message ?? 'unknown request error')
                    logger?.error?.('[Pull] Could not move configured account', {
                        userId: job.userId,
                        guildId: job.guildId,
                        sourceChannelId: job.sourceChannelId,
                        destinationChannelId: destinationInfo.channelId,
                        error,
                    })
                } finally {
                    moving.delete(job.userId)
                }

                await delay(MOVE_SPACING_MS)
            }

            if (rateLimited) {
                status('Discord rate-limited Pull. It will check again after Discord updates voice state.')
                return
            }

            if (jobs.length === 0 && moved === 0 && failed === 0) {
                const parts = [
                    `Watching ${targetIds.length} configured account(s).`,
                    notInVoice ? `${notInVoice} not in voice` : '',
                    otherServer ? `${otherServer} in another server` : '',
                    alreadyWithYou ? `${alreadyWithYou} already with you` : '',
                    permissionBlocked ? `${permissionBlocked} blocked by channel permissions` : '',
                    coolingDown ? `${coolingDown} waiting for the move cooldown` : '',
                ].filter(Boolean)
                status(parts.join(' '))
                return
            }

            const parts = [
                moved ? `Moved ${moved} account(s) to your current channel.` : '',
                permissionBlocked ? `${permissionBlocked} blocked by channel permissions.` : '',
                notInVoice ? `${notInVoice} not in voice.` : '',
                otherServer ? `${otherServer} in another server.` : '',
                failed ? `${failed} move(s) failed (${lastFailure || 'unknown error'}); check permissions and debug logs.` : '',
                parsed.overflow ? `Only the first ${MAX_TARGETS} valid IDs are used.` : '',
            ].filter(Boolean)

            status(parts.join(' ') || 'Pull is active and waiting for voice updates.')
        }

        const unsubscribe = onAnyFluxEventDispatched(payload => {
            const type = String((payload as any)?.type ?? '')
            if (
                type.includes('VOICE_STATE') ||
                type.includes('CHANNEL_UPDATE') ||
                type.includes('GUILD_ROLE_UPDATE') ||
                type.includes('GUILD_MEMBER_UPDATE')
            ) {
                scheduleReconcile()
            }
            return payload
        })

        pollTimer = setInterval(scheduleReconcile, 2000)
        cleanup(
            unsubscribe,
            unsubscribeUserStore,
            unsubscribeVoiceStore,
            unsubscribeChannelStore,
            unsubscribePermissionStore,
            unsubscribeHttpModule,
            ...commandUnsubscribers,
            () => {
                stopped = true
                if (reconcileTimer) clearTimeout(reconcileTimer)
                if (pollTimer) clearInterval(pollTimer)
                moving.clear()
                moveHistory.clear()
                pausedUntil.clear()
                globalMoveHistory = []
            },
        )

        status(jsonStorage.cache?.enabled ? 'Pull is armed. Checking configured accounts.' : 'Pull is stopped.')
        scheduleReconcile()
        logger?.log?.('Pull started.')
    },

    SettingsComponent({ api }) {
        const settings = api.jsonStorage.use() ?? DEFAULT_SETTINGS
        const [draft, setDraft] = React.useState(String(settings.userIds ?? ''))

        React.useEffect(() => {
            setDraft(String(settings.userIds ?? ''))
        }, [settings.userIds])

        const enabled = Boolean(settings.enabled)
        const statusText = String(settings.status ?? 'Pull is stopped.')

        const buttonStyle = {
            paddingVertical: 12,
            paddingHorizontal: 16,
            borderRadius: 8,
            alignItems: 'center' as const,
            marginTop: 10,
        }

        const buttonTextStyle = {
            color: '#FFFFFF',
            fontSize: 15,
            fontWeight: '600' as const,
        }

        const textColor = '#F2F3F5'
        const mutedColor = '#B5BAC1'

        const saveTargets = () => {
            void api.jsonStorage.set({ userIds: draft.trim() })
        }

        const startPull = () => {
            void api.jsonStorage.set({
                userIds: draft.trim(),
                enabled: true,
            })
        }

        const stopPull = () => {
            void api.jsonStorage.set({ enabled: false, status: 'Pull is stopped.' })
        }

        return (
            <ScrollView contentContainerStyle={{ padding: 16 }}>
                <View style={{ gap: 8 }}>
                    <Text style={{ color: textColor, fontSize: 21, fontWeight: '700' }}>
                        Pull
                    </Text>
                    <Text style={{ color: mutedColor, fontSize: 14 }}>
                        Add the Discord user IDs of the accounts you want to move into your current voice channel.
                        Enter one ID per line, or separate IDs with commas. Up to 20 IDs are supported.
                    </Text>

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
                            minHeight: 150,
                            padding: 12,
                            borderRadius: 8,
                            color: textColor,
                            backgroundColor: 'rgba(128,128,128,0.16)',
                            fontSize: 15,
                        }}
                    />

                    <Pressable
                        onPress={saveTargets}
                        style={{ ...buttonStyle, backgroundColor: '#4E5058' }}
                        accessibilityRole="button"
                    >
                        <Text style={buttonTextStyle}>Save IDs</Text>
                    </Pressable>

                    <Pressable
                        onPress={startPull}
                        style={{ ...buttonStyle, backgroundColor: '#5865F2' }}
                        accessibilityRole="button"
                    >
                        <Text style={buttonTextStyle}>Start Pull</Text>
                    </Pressable>

                    <Pressable
                        onPress={stopPull}
                        style={{ ...buttonStyle, backgroundColor: '#4E5058' }}
                        accessibilityRole="button"
                    >
                        <Text style={buttonTextStyle}>Stop Pull</Text>
                    </Pressable>

                    <Text style={{ color: textColor, fontSize: 16, fontWeight: '700', marginTop: 10 }}>
                        Status
                    </Text>
                    <Text style={{ color: mutedColor, fontSize: 14 }}>
                        {enabled ? 'Enabled' : 'Disabled'} · {statusText}
                    </Text>

                    <Text style={{ color: mutedColor, fontSize: 12, marginTop: 8 }}>
                        Pull only acts on IDs you enter. It checks Move Members in the source and destination channels,
                        plus Connect in your destination channel. It does not bypass Discord permissions. Moves may
                        appear in the server audit log.
                    </Text>
                </View>
            </ScrollView>
        )
    },
})
