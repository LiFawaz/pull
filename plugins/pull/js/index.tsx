import React from 'react'
import { ToastActionCreators } from '@valenced/discord/actions'
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { getStore, onAnyFluxEventDispatched } from '@valenced/discord/flux'
import { getModules } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import {
    canMoveBetween,
    getMovePermissionIssue,
    capacityWaitKey,
    checkCapacityWait,
    createSettingsActions,
    getResponseBody,
    getRetryAfterMs,
    getVoiceChannelCapacity,
    isCapacityError,
    parseTargetIds,
    getReconcileDelayMs,
    prioritizeWaitingTargets,
    resolveCurrentVoiceInfo,
    getVoiceModerationPermissions,
} from './helpers'

interface PullSettings {
    userIds: string
    enabled: boolean
    status: string
    blockUserIds: string
    blockEnabled: boolean
    blockMute: boolean
    blockDeafen: boolean
    blockDisconnect: boolean
    blockStatus: string
}

const DEFAULT_SETTINGS: PullSettings = {
    userIds: '',
    enabled: false,
    status: 'Pull is stopped.',
    blockUserIds: '',
    blockEnabled: false,
    blockMute: true,
    blockDeafen: true,
    blockDisconnect: true,
    blockStatus: 'Block is stopped.',
}

let activeResetRuntimeState: (() => void) | null = null
let activeResetBlockRuntimeState: (() => void) | null = null

const MAX_TARGETS = 20
const MOVE_SPACING_MS = 250
const HISTORY_WINDOW_MS = 60_000
const MAX_MOVES_PER_TARGET = 10
const TARGET_PAUSE_MS = 30_000
const MAX_MOVES_GLOBAL = 40
const POLL_INTERVAL_MS = 250
const MOVE_CONFIRMATION_TIMEOUT_MS = 8_000
const RETRY_BASE_MS = 5_000
const RETRY_MAX_MS = 60_000
const RATE_LIMIT_FALLBACK_MS = 10_000
const BLOCK_POLL_INTERVAL_MS = 500
const BLOCK_ACTION_SPACING_MS = 300

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
        const moveHistory = new Map<string, number[]>()
        const pausedUntil = new Map<string, number>()
        const pendingMoves = new Map<string, { channelId: string; requestedAt: number }>()
        const retryStates = new Map<string, { attempts: number; nextAttemptAt: number }>()
        const fullChannelWait = new Set<string>()
        let globalRetryAt = 0
        let globalMoveHistory: number[] = []

        let blockCheckTimer: ReturnType<typeof setTimeout> | null = null
        let blockPollTimer: ReturnType<typeof setInterval> | null = null
        let blockChecking = false
        let blockCheckAgain = false
        let lastBlockStatus = ''
        const blockPresence = new Map<string, boolean>()
        const blockRunning = new Set<string>()

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

        function blockStatus(message: string) {
            if (message === lastBlockStatus) return
            lastBlockStatus = message
            try {
                void jsonStorage.set({ blockStatus: message })
            } catch (error) {
                logger?.error?.('[Block] Could not save status', error)
            }
            logger?.log?.('[Block]', message)
        }

        function clearBlockRuntimeState() {
            blockPresence.clear()
            blockRunning.clear()
        }
        activeResetBlockRuntimeState = clearBlockRuntimeState


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

        function clearRetryState() {
            pendingMoves.clear()
            retryStates.clear()
            fullChannelWait.clear()
            globalRetryAt = 0
        }
        activeResetRuntimeState = clearRetryState

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

                        clearRetryState()
                        await jsonStorage.set({
                            userIds: parsed.ids.join('\n'),
                            enabled: true,
                        })
                        status(`Pull is armed for ${parsed.ids.length} configured accounts.`)
                        scheduleReconcile(true)
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
                        clearRetryState()
                        await jsonStorage.set({ enabled: false })
                        status('Pull is stopped.')
                        scheduleReconcile(true)
                        commandToast('All pulling has been stopped.', 'success')
                    },
                }))

                commandUnsubscribers.push(commandRegistry.registerCommand({
                    name: 'block',
                    displayName: 'block',
                    description: 'Protect your active voice channel from selected users',
                    displayDescription: 'Watch your active voice channel for selected users',
                    applicationId: '-1',
                    inputType: 1,
                    type: 1,
                    shouldHide: () => false,
                    options: Array.from({ length: MAX_TARGETS }, (_, index) => {
                        const name = 'id' + (index + 1)
                        return {
                            name,
                            displayName: name,
                            description: 'Discord user ID ' + (index + 1),
                            displayDescription: 'Enter a Discord user ID to watch',
                            type: 3,
                            required: index === 0,
                        }
                    }),
                    execute: async (args: any[]) => {
                        const values = (Array.isArray(args) ? args : [])
                            .filter((arg: any) => /^id\\d+$/.test(String(arg?.name ?? '')))
                            .map((arg: any) => String(arg?.value ?? '').trim())
                            .filter((value: string) => value.length > 0)
                        if (!values.length || values.some((id: string) => !/^\\d{15,22}$/.test(id))) {
                            commandToast('Enter one or more valid numeric Discord user IDs.', 'critical')
                            return
                        }
                        const ids = [...new Set(values)]
                        if (ids.length > MAX_TARGETS) {
                            commandToast('You can watch up to ' + MAX_TARGETS + ' different user IDs.', 'critical')
                            return
                        }
                        clearBlockRuntimeState()
                        await jsonStorage.set({
                            blockUserIds: ids.join('\\n'),
                            blockEnabled: true,
                            blockStatus: 'Watching ' + ids.length + ' selected user(s) in your active voice channel.',
                        })
                        blockStatus('Watching ' + ids.length + ' selected user(s) in your active voice channel.')
                        scheduleBlockCheck(true)
                        commandToast('Block protection enabled for ' + ids.length + ' user(s).', 'success')
                    },
                }))

                commandUnsubscribers.push(commandRegistry.registerCommand({
                    name: 'unblock',
                    displayName: 'unblock',
                    description: 'Pause Block voice protection',
                    displayDescription: 'Pause Block voice protection',
                    applicationId: '-1',
                    inputType: 1,
                    type: 1,
                    shouldHide: () => false,
                    execute: async () => {
                        clearBlockRuntimeState()
                        await jsonStorage.set({
                            blockEnabled: false,
                            blockStatus: 'Block is paused. Saved IDs are kept.',
                        })
                        blockStatus('Block is paused. Saved IDs are kept.')
                        commandToast('Block protection paused. Saved IDs were kept.', 'success')
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

        function makeVoiceInfo(state: any, indexedGuildId: string | null = null) {
            if (!state) return { channelId: null, guildId: indexedGuildId, channel: null }

            const rawChannelId = state.channelId ?? state.channel_id
            const channelId = rawChannelId == null ? null : String(rawChannelId)
            if (!channelId) {
                return {
                    channelId: null,
                    guildId: indexedGuildId ?? state.guildId ?? state.guild_id ?? null,
                    channel: null,
                }
            }

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

        function getVoiceInfo(userId: string, preferredGuildId?: string | null): {
            channelId: string | null
            guildId: string | null
            channel: any
        } {
            // Prefer the destination server when an account has multiple voice sessions.
            if (preferredGuildId) {
                try {
                    const direct =
                        voiceStore?.getVoiceState?.(preferredGuildId, userId) ??
                        voiceStore?.getVoiceStates?.(preferredGuildId)?.[userId] ??
                        voiceStore?.getAllVoiceStates?.()?.[preferredGuildId]?.[userId]
                    if (direct) return makeVoiceInfo(direct, preferredGuildId)
                } catch (error) {
                    logger?.error?.('[Pull] Preferred guild voice lookup failed', error)
                }
            }

            try {
                const all = voiceStore?.getAllVoiceStates?.()
                if (all && typeof all === 'object') {
                    for (const [guildId, members] of Object.entries(all)) {
                        if (guildId === '@me' || !members || typeof members !== 'object') continue
                        const candidate = (members as any)[userId]
                        if (candidate) return makeVoiceInfo(candidate, String(guildId))
                    }
                }
            } catch (error) {
                logger?.error?.('[Pull] All voice states lookup failed', error)
            }

            try {
                const state = voiceStore?.getVoiceStateForUser?.(userId) ?? null
                if (state) return makeVoiceInfo(state)
            } catch (error) {
                logger?.error?.('[Pull] Per-user voice state lookup failed', error)
            }

            return { channelId: null, guildId: null, channel: null }
        }

        function getCurrentVoiceInfo(userId: string) {
            const info = resolveCurrentVoiceInfo(userId, voiceStore, channelStore)
            if (!info.channelId) {
                logger?.log?.('[Pull] Active account is not connected to a voice channel; waiting to resume.')
            }
            return info
        }

        function getDestinationCapacity(channel: any, guildId: string, channelId: string) {
            try {
                const all = voiceStore?.getAllVoiceStates?.()
                let reserved = 0
                for (const [userId, pending] of pendingMoves.entries()) {
                    if (pending.channelId !== channelId) continue
                    if (getVoiceInfo(userId, guildId).channelId !== channelId) reserved++
                }
                return getVoiceChannelCapacity(channel, all?.[guildId], channelId, reserved)
            } catch (error) {
                logger?.error?.('[Pull] Could not inspect voice channel capacity', error)
                return null
            }
        }

        function scheduleTargetRetry(userId: string, now: number, baseMs = RETRY_BASE_MS): number {
            const previous = retryStates.get(userId)
            const attempts = Math.min((previous?.attempts ?? 0) + 1, 8)
            const waitMs = Math.min(baseMs * 2 ** (attempts - 1), RETRY_MAX_MS)
            retryStates.set(userId, { attempts, nextAttemptAt: now + waitMs })
            return waitMs
        }

        function keepRecent(stamps: number[], now: number): number[] {
            return stamps.filter(at => now - at < HISTORY_WINDOW_MS)
        }

        let reconcileScheduledImmediate = false

        function scheduleReconcile(immediate = false) {
            if (stopped) return

            // An immediate voice-state event supersedes a pending fallback timer.
            // Repeated events do not keep postponing an already scheduled run.
            if (reconcileTimer) {
                if (!immediate || reconcileScheduledImmediate) return
                clearTimeout(reconcileTimer)
            }

            reconcileScheduledImmediate = immediate
            reconcileTimer = setTimeout(() => {
                reconcileTimer = null
                reconcileScheduledImmediate = false
                void reconcile()
            }, getReconcileDelayMs(immediate))
        }

        // getStore is callback-based: stores may not exist yet when the plugin starts.
        const unsubscribeUserStore = getStore('UserStore', (store: any) => {
            userStore = store
            scheduleReconcile(true)
        })
        const unsubscribeVoiceStore = getStore('VoiceStateStore', (store: any) => {
            voiceStore = store
            scheduleReconcile(true)
        })
        const unsubscribeChannelStore = getStore('ChannelStore', (store: any) => {
            channelStore = store
            scheduleReconcile(true)
        })
        const unsubscribePermissionStore = getStore('PermissionStore', (store: any) => {
            permissionStore = store
            scheduleReconcile(true)
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
                    scheduleReconcile(true)
                }
            },
        )

        let reconcileStage = 'starting'

        async function reconcile() {
            if (stopped) return
            if (reconciling) {
                reconcileAgain = true
                return
            }

            reconciling = true
            reconcileStage = 'reading settings'
            try {
                await runReconcile()
            } catch (error: any) {
                const message = error instanceof Error
                    ? `${error.name}: ${error.message}`
                    : String(error ?? 'Unknown error')
                logger?.error?.('[Pull] Reconciliation failed', {
                    stage: reconcileStage,
                    message,
                    stack: error?.stack,
                    error,
                })
                status(`Pull failed while ${reconcileStage}: ${message}. See Debug Logs.`)
            } finally {
                reconciling = false
                if (reconcileAgain) {
                    reconcileAgain = false
                    scheduleReconcile(true)
                }
            }
        }

        async function runReconcile() {
            reconcileStage = 'reading saved settings'
            const settings = jsonStorage.cache ?? DEFAULT_SETTINGS
            if (!settings.enabled) {
                status('Pull is stopped.')
                return
            }

            const parsed = parseTargetIds(settings.userIds, MAX_TARGETS)
            const targetIds = parsed.ids
            if (!targetIds.length) {
                status('Add at least one valid Discord user ID, then start Pull.')
                return
            }

            reconcileStage = 'finding your active Discord account'
            const ownId = getCurrentUserId()
            if (!ownId) {
                status('Waiting for your Discord account to load.')
                return
            }

            reconcileStage = 'finding your current voice channel'
            const destinationInfo = getCurrentVoiceInfo(ownId)
            if (!destinationInfo.channelId || !destinationInfo.guildId) {
                status('Pull is armed and waiting for you to join a voice channel. It will resume automatically.')
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

            reconcileStage = 'reading configured accounts voice states'
            const jobs: Array<{
                userId: string
                sourceChannelId: string
                guildId: string
            }> = []
            let notInVoice = 0
            let otherServer = 0
            let alreadyWithYou = 0
            let permissionBlocked = 0
            let discordPermissionRejected = 0
            const permissionIssues = new Set<string>()
            let coolingDown = 0
            let awaitingConfirmation = 0
            let waitingForCapacity = 0
            const now = Date.now()
            const configuredTargets = new Set(targetIds)

            // Wait states belong to one destination only. Clear stale channels and removed IDs.
            const currentWaitPrefix = `${destinationInfo.channelId}:`
            for (const waitKey of fullChannelWait) {
                const waitingUserId = waitKey.startsWith(currentWaitPrefix)
                    ? waitKey.slice(currentWaitPrefix.length)
                    : ''
                if (!waitingUserId || !configuredTargets.has(waitingUserId)) {
                    fullChannelWait.delete(waitKey)
                }
            }

            // Remove reservations for targets that were removed or whose confirmation timed out.
            for (const [userId, pending] of pendingMoves.entries()) {
                if (
                    !configuredTargets.has(userId) ||
                    now - pending.requestedAt >= MOVE_CONFIRMATION_TIMEOUT_MS
                ) {
                    pendingMoves.delete(userId)
                }
            }

            // Accounts already waiting for capacity get first chance at the next slot.
            const orderedTargetIds = prioritizeWaitingTargets(targetIds, fullChannelWait, destinationInfo.channelId)

            for (const userId of orderedTargetIds) {
                if (userId === ownId) continue

                const target = getVoiceInfo(userId, destinationInfo.guildId)
                const waitKey = capacityWaitKey(userId, destinationInfo.channelId)
                if (!target.channelId) {
                    pendingMoves.delete(userId)
                    fullChannelWait.delete(waitKey)
                    notInVoice++
                    continue
                }

                if (!target.guildId || target.guildId !== destinationInfo.guildId) {
                    pendingMoves.delete(userId)
                    fullChannelWait.delete(waitKey)
                    otherServer++
                    continue
                }

                if (target.channelId === destinationInfo.channelId) {
                    pendingMoves.delete(userId)
                    fullChannelWait.delete(waitKey)
                    retryStates.delete(userId)
                    alreadyWithYou++
                    continue
                }

                const pending = pendingMoves.get(userId)
                if (pending && pending.channelId !== destinationInfo.channelId) {
                    pendingMoves.delete(userId)
                } else if (pending && now - pending.requestedAt < MOVE_CONFIRMATION_TIMEOUT_MS) {
                    awaitingConfirmation++
                    continue
                } else if (pending) {
                    pendingMoves.delete(userId)
                }

                reconcileStage = `checking voice capacity for ${userId}`
                const capacity = getDestinationCapacity(destinationChannel, destinationInfo.guildId, destinationInfo.channelId)
                const capacityWait = checkCapacityWait(fullChannelWait, waitKey, capacity)
                // Do not pre-block a new target just because the channel looks full.
                // Discord must evaluate that target's effective Connect/user-limit access
                // (for example, an Administrator override). Only targets rejected for
                // capacity are put into fullChannelWait.
                if (capacityWait === 'waiting') {
                    waitingForCapacity++
                    continue
                }
                if (capacityWait === 'released') retryStates.delete(userId)

                const retry = retryStates.get(userId)
                if (retry && retry.nextAttemptAt > now) {
                    coolingDown++
                    continue
                }

                reconcileStage = 'checking destination permissions'
                const permissionIssue = getMovePermissionIssue(permissionStore, destinationChannel)
                if (permissionIssue) {
                    permissionBlocked++
                    permissionIssues.add(permissionIssue)
                    continue
                }

                const paused = pausedUntil.get(userId) ?? 0
                const recentUserMoves = keepRecent(moveHistory.get(userId) ?? [], now)
                moveHistory.set(userId, recentUserMoves)

                if (paused > now) {
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
                    guildId: destinationInfo.guildId,
                })
            }

            globalMoveHistory = keepRecent(globalMoveHistory, now)
            if (globalMoveHistory.length >= MAX_MOVES_GLOBAL) {
                status('Pull is paused briefly by its safety limit (40 moves per minute). It will resume automatically.')
                return
            }

            if (globalRetryAt > Date.now()) {
                status(`Discord rate limit cooldown. Pull will retry in ${Math.ceil((globalRetryAt - Date.now()) / 1000)}s.`)
                return
            }

            let moved = 0
            let failed = 0
            let rateLimited = false
            let lastFailure = ''

            for (const job of jobs) {
                reconcileStage = `sending move request for ${job.userId}`
                if (stopped || !jsonStorage.cache?.enabled) break

                // Do not keep sending moves to an old destination if you switch channels mid-queue.
                const latestDestination = getCurrentVoiceInfo(ownId)
                if (
                    latestDestination.channelId !== destinationInfo.channelId ||
                    latestDestination.guildId !== destinationInfo.guildId
                ) {
                    scheduleReconcile(true)
                    break
                }

                const latestTarget = getVoiceInfo(job.userId, job.guildId)
                if (latestTarget.channelId === destinationInfo.channelId) {
                    pendingMoves.delete(job.userId)
                    retryStates.delete(job.userId)
                    continue
                }
                if (
                    latestTarget.channelId !== job.sourceChannelId ||
                    latestTarget.guildId !== job.guildId
                ) {
                    continue
                }

                reconcileStage = 'checking destination permissions'
                const permissionIssue = getMovePermissionIssue(permissionStore, destinationChannel)
                if (permissionIssue) {
                    permissionBlocked++
                    permissionIssues.add(permissionIssue)
                    continue
                }

                const latestCapacity = getDestinationCapacity(destinationChannel, job.guildId, destinationInfo.channelId)
                const capacityWait = checkCapacityWait(fullChannelWait, capacityWaitKey(job.userId, destinationInfo.channelId), latestCapacity)
                // Re-check only users Discord previously rejected for capacity.
                // A full snapshot alone cannot tell us whether this target has an override.
                if (capacityWait === 'waiting') {
                    waitingForCapacity++
                    continue
                }
                if (capacityWait === 'released') retryStates.delete(job.userId)

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
                    pendingMoves.set(job.userId, {
                        channelId: destinationInfo.channelId,
                        requestedAt: stamp,
                    })
                    retryStates.delete(job.userId)
                    moved++
                } catch (error: any) {
                    const errorBody = getResponseBody(error)
                    const statusCode = Number(error?.status ?? error?.response?.status ?? error?.statusCode ?? 0)
                    const code = Number(errorBody?.code ?? error?.body?.code ?? error?.response?.data?.code ?? 0)
                    const errorMessage = String(errorBody?.message ?? error?.message ?? '').toLowerCase()

                    if (statusCode === 429) {
                        failed++
                        globalRetryAt = Date.now() + getRetryAfterMs(error, RATE_LIMIT_FALLBACK_MS)
                        rateLimited = true
                        logger?.warn?.('[Pull] Discord rate-limited a voice move', error)
                        break
                    }

                    if (isCapacityError(errorMessage)) {
                        const capacity = getDestinationCapacity(destinationChannel, job.guildId, destinationInfo.channelId)
                        retryStates.delete(job.userId)
                        if (capacity?.isFull) {
                            fullChannelWait.add(capacityWaitKey(job.userId, destinationInfo.channelId))
                            waitingForCapacity++
                            lastFailure = 'destination voice channel is full; waiting for a free slot'
                        } else {
                            failed++
                            retryStates.set(job.userId, { attempts: 1, nextAttemptAt: Date.now() + 1_500 })
                            lastFailure = 'destination voice channel rejected the move; checking again shortly'
                        }
                        continue
                    }

                    failed++
                    const isPermissionFailure = statusCode === 403 || code === 50013
                    const retryDelay = scheduleTargetRetry(job.userId, Date.now(), isPermissionFailure ? 30_000 : RETRY_BASE_MS)
                    if (isPermissionFailure) {
                        permissionBlocked++
                        discordPermissionRejected++
                    }

                    lastFailure = statusCode
                        ? `HTTP ${statusCode}${code ? ` (Discord code ${code})` : ''}, retry in ${Math.ceil(retryDelay / 1000)}s`
                        : `${String(error?.message ?? 'unknown request error')}, retry in ${Math.ceil(retryDelay / 1000)}s`
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
                status(`Discord rate-limited Pull. Retrying in ${Math.ceil(Math.max(0, globalRetryAt - Date.now()) / 1000)}s.`)
                return
            }

            if (moved === 0 && failed === 0) {
                const capacity = getDestinationCapacity(destinationChannel, destinationInfo.guildId, destinationInfo.channelId)
                const parts = [
                    `Watching ${targetIds.length} configured account(s).`,
                    capacity ? `VC occupancy: ${capacity.occupancy + capacity.reserved}/${capacity.limit}${capacity.reserved ? ` (${capacity.reserved} pending)` : capacity.isFull ? ' (full)' : ''}.` : '',
                    awaitingConfirmation ? `${awaitingConfirmation} waiting for Discord voice-state confirmation` : '',
                    waitingForCapacity ? `${waitingForCapacity} waiting for a free voice slot` : '',
                    notInVoice ? `${notInVoice} not in voice` : '',
                    otherServer ? `${otherServer} in another server` : '',
                    alreadyWithYou ? `${alreadyWithYou} already with you` : '',
                    permissionBlocked && permissionIssues.size
                        ? `PermissionStore denied ${Array.from(permissionIssues).join(' and ')} in the destination channel.`
                        : '',
                    discordPermissionRejected
                        ? `Discord rejected ${discordPermissionRejected} move(s) with HTTP 403 / code 50013; check the target's role hierarchy and channel permissions.`
                        : '',
                    coolingDown ? `${coolingDown} waiting for the move cooldown` : '',
                ].filter(Boolean)
                status(parts.join(' '))
                return
            }

            const parts = [
                moved ? `Moved ${moved} account(s) to your current channel.` : '',
                waitingForCapacity ? `${waitingForCapacity} waiting for a free voice slot.` : '',
                awaitingConfirmation ? `${awaitingConfirmation} waiting for voice-state confirmation.` : '',
                coolingDown ? `${coolingDown} waiting for the move cooldown.` : '',
                permissionBlocked && permissionIssues.size
                    ? `PermissionStore denied ${Array.from(permissionIssues).join(' and ')} in the destination channel.`
                    : '',
                discordPermissionRejected
                    ? `Discord rejected ${discordPermissionRejected} move(s) with HTTP 403 / code 50013; check the target's role hierarchy and channel permissions.`
                    : '',
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
                scheduleReconcile(true)
            }
            return payload
        })

        pollTimer = setInterval(() => scheduleReconcile(true), POLL_INTERVAL_MS)
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
                if (activeResetRuntimeState === clearRetryState) activeResetRuntimeState = null
                if (reconcileTimer) clearTimeout(reconcileTimer)
                reconcileScheduledImmediate = false
                if (pollTimer) clearInterval(pollTimer)
                moving.clear()
                moveHistory.clear()
                pausedUntil.clear()
                clearRetryState()
                globalMoveHistory = []
            },
        )

        status(jsonStorage.cache?.enabled ? 'Pull is armed. Checking configured accounts.' : 'Pull is stopped.')
        scheduleReconcile(true)
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

        const settingsActions = createSettingsActions(api.jsonStorage, () => activeResetRuntimeState?.())

        const saveTargets = () => {
            void settingsActions.saveTargets(draft)
        }

        const startPull = () => {
            void settingsActions.startPull(draft)
        }

        const stopPull = () => {
            void settingsActions.stopPull()
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
                        Pull only acts on IDs you enter and only within the same server. It checks your active
                        account's Move Members and destination Connect permissions. It waits for available channel
                        capacity and confirms each move through Discord voice state.
                    </Text>
                </View>
            </ScrollView>
        )
    },
})
