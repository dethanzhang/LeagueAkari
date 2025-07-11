import { i18next } from '@main/i18n'
import { IAkariShardInitDispose, Shard } from '@shared/akari-shard'
import { EMPTY_PUUID } from '@shared/constants/common'
import { Game, GameTimeline } from '@shared/types/league-client/match-history'
import {
  MatchHistoryGamesAnalysisAll,
  MatchHistoryGamesAnalysisTeamSide,
  analyzeMatchHistory,
  analyzeTeamMatchHistory
} from '@shared/utils/analysis'
import { calculateTogetherTimes, removeOverlappingSubsets } from '@shared/utils/team-up-calc'
import { isAxiosError } from 'axios'
import _ from 'lodash'
import { comparer, computed, runInAction, toJS } from 'mobx'
import PQueue from 'p-queue'
import LRUMap from 'quick-lru'

import { AkariIpcMain } from '../ipc'
import { LeagueClientMain } from '../league-client'
import { AkariLogger, LoggerFactoryMain } from '../logger-factory'
import { MobxUtilsMain } from '../mobx-utils'
import { SavedPlayerMain } from '../saved-player'
import { SettingFactoryMain } from '../setting-factory'
import { SetterSettingService } from '../setting-factory/setter-setting-service'
import { SgpMain } from '../sgp'
import { OngoingGameSettings, OngoingGameState } from './state'

/**
 * 用于游戏过程中的对局分析, 包括在此期间的战绩查询, 计算等
 */
@Shard(OngoingGameMain.id)
export class OngoingGameMain implements IAkariShardInitDispose {
  static id = 'ongoing-game-main'

  static LOADING_PRIORITY = {
    ADDITIONAL_SUMMONER: -1,
    SUMMONER: 6,
    MATCH_HISTORY: 5,
    SAVED_INFO: 4,
    RANKED_STATS: 3,
    CHAMPION_MASTERY: 2,
    ADDITIONAL_GAME: 2,
    GAME_TIMELINE: 1
  }

  /**
   * 目前已知的可用队列, 这是为了避免查询不支持队列时返回为空的情况
   */
  static SAFE_TAGS = new Set([
    `q_420`,
    `q_430`,
    `q_440`,
    `q_450`, // ARAM
    `q_480`, // SWIFTPLAY
    `q_490`,
    `q_900`, // URF
    `q_1400`, // ULTBOOK
    `q_1700`,
    `q_1900`,
    'q_2300' // BRAWL
  ])

  private readonly _log: AkariLogger
  private readonly _setting: SetterSettingService

  public readonly settings = new OngoingGameSettings()
  public readonly state: OngoingGameState

  private _gameLruMap = new LRUMap<
    number,
    {
      source: 'lcu' | 'sgp'
      data: Game
    }
  >({
    maxSize: 400
  })

  private _gameTimelineLruMap = new LRUMap<
    number,
    {
      source: 'lcu' | 'sgp'
      data: GameTimeline
    }
  >({
    maxSize: 400
  })

  /** 为**加载战绩**设置的特例 */
  private readonly _mhQueue = new PQueue()
  /** 为**加载战绩**设置的特例 */
  private _mhController: AbortController | null = null

  /**
   * 其他 API 的并发控制
   */
  private readonly _queue = new PQueue()
  private _controller: AbortController | null = null

  private _debouncedUpdateMatchHistoryFn = _.debounce(() => this._updateMatchHistory(), 250)

  constructor(
    private readonly _loggerFactory: LoggerFactoryMain,
    private readonly _settingFactory: SettingFactoryMain,
    private readonly _lc: LeagueClientMain,
    private readonly _mobx: MobxUtilsMain,
    private readonly _ipc: AkariIpcMain,
    private readonly _sgp: SgpMain,
    private readonly _saved: SavedPlayerMain
  ) {
    this._log = _loggerFactory.create(OngoingGameMain.id)
    this._setting = _settingFactory.register(
      OngoingGameMain.id,
      {
        concurrency: { default: this.settings.concurrency },
        enabled: { default: this.settings.enabled },
        matchHistoryLoadCount: { default: this.settings.matchHistoryLoadCount },
        premadeTeamThreshold: { default: this.settings.premadeTeamThreshold },
        matchHistoryUseSgpApi: { default: this.settings.matchHistoryUseSgpApi },
        matchHistoryTagPreference: { default: this.settings.matchHistoryTagPreference },
        gameTimelineLoadCount: { default: this.settings.matchHistoryLoadCount }
      },
      this.settings
    )
    this.state = new OngoingGameState(this._lc.data)
  }

  private async _handleState() {
    await this._setting.applyToState()
    this._mobx.propSync(OngoingGameMain.id, 'settings', this.settings, [
      'concurrency',
      'enabled',
      'matchHistoryLoadCount',
      'premadeTeamThreshold',
      'matchHistoryUseSgpApi',
      'matchHistoryTagPreference',
      'gameTimelineLoadCount'
    ])
    this._mobx.propSync(OngoingGameMain.id, 'state', this.state, [
      'championSelections',
      'gameInfo',
      'positionAssignments',
      'playerStats',
      'inferredPremadeTeams',
      'queryStage',
      'teams',
      'matchHistoryTag',
      'matchHistoryLoadingState',
      'summonerLoadingState',
      'savedInfoLoadingState',
      'rankedStatsLoadingState',
      'championMasteryLoadingState',
      'teamParticipantGroups'
    ])
  }

  async onInit() {
    await this._handleState()

    this._handlePQueue()
    this._handleIpcCall()
    this._handleCalculation()
    this._handleEndOfGameSave()
    this._handleRemindTaggedPlayers()

    this._handleLoad()

    // for better control
    this._setting.onChange('matchHistoryLoadCount', async (value, { setter }) => {
      if (value >= 1 && value <= 200) {
        await setter(value)
        this._debouncedUpdateMatchHistoryFn()
      }

      this._setting.set(
        'gameTimelineLoadCount',
        Math.min(value, this.settings.gameTimelineLoadCount)
      )
    })

    this._setting.onChange('matchHistoryUseSgpApi', async (value, { setter }) => {
      await setter(value)
      this._debouncedUpdateMatchHistoryFn()
    })

    this._setting.onChange('premadeTeamThreshold', async (value, { setter }) => {
      if (value >= 2) {
        await setter(value)
      }
    })

    this._setting.onChange('gameTimelineLoadCount', async (value, { setter }) => {
      if (value >= 0 && value <= this.settings.matchHistoryLoadCount) {
        await setter(value)
        return
      }

      await setter(this.settings.matchHistoryLoadCount)
    })
  }

  private _handlePQueue() {
    this._mobx.reaction(
      () => this.settings.concurrency,
      (concurrency) => {
        this._mhQueue.concurrency = concurrency
        this._queue.concurrency = concurrency
      },
      { fireImmediately: true }
    )
  }

  private _handleLoad() {
    this._mobx.reaction(
      () =>
        [
          this.state.queryStage,
          this.settings.enabled,
          this._sgp.state.isTokenReady,
          this.settings.matchHistoryUseSgpApi
        ] as const,
      ([stage, enabled, tokenReady, useSgpApi]) => {
        this._log.info(
          'Handle auto match history loading',
          `queryStage=${JSON.stringify(this.state.queryStage, null, 2)}`,
          `enabled=${this.settings.enabled}`,
          `tokenReady=${this._sgp.state.isTokenReady}`
        )

        if (this._controller) {
          this._controller.abort()
          this._controller = null
        }

        if (this._mhController) {
          this._mhController.abort()
          this._mhController = null
        }

        this._debouncedUpdateMatchHistoryFn.cancel()

        if (stage.phase === 'unavailable' || !enabled || (useSgpApi && !tokenReady)) {
          this.state.clear()
          this.state.setMatchHistoryTag('all')
          this._ipc.sendEvent(OngoingGameMain.id, 'clear')
          return
        }

        this._controller = new AbortController()
        this._mhController = new AbortController()

        if (this.state.queryStage.phase === 'champ-select') {
          this._champSelect({
            mhSignal: this._mhController.signal,
            signal: this._controller.signal,
            force: false
          })
        } else if (this.state.queryStage.phase === 'in-game') {
          this._inGame({
            mhSignal: this._mhController.signal,
            signal: this._controller.signal,
            force: false
          })
        }
      },
      { equals: comparer.shallow, fireImmediately: true }
    )
  }

  private _updateMatchHistory() {
    if (!this.settings.enabled) {
      return
    }

    if (this.state.queryStage.phase === 'unavailable') {
      return
    }

    if (this._mhController) {
      this._mhController.abort()
      this._mhController = null
    }

    const controller = new AbortController()
    this._mhController = controller

    const puuids = this.getPuuidsToLoadForPlayers()

    puuids.forEach((puuid) => {
      this._loadPlayerMatchHistory(puuid, {
        mhSignal: controller.signal,
        count: this.settings.matchHistoryLoadCount,
        tag: this.state.matchHistoryTag,
        force: false,
        useSgpApi: this.settings.matchHistoryUseSgpApi
      })
    })
  }

  private _getCurrentGameMatchHistoryTag() {
    if (!this.state.queryStage.gameInfo) {
      return 'all'
    }

    if (OngoingGameMain.SAFE_TAGS.has(`q_${this.state.queryStage.gameInfo.queueId}`)) {
      return `q_${this.state.queryStage.gameInfo.queueId}`
    }

    return 'all'
  }

  /**
   *
   * @param options 其中的 force, 用于标识是否强制刷新. 若为 false, 在查询条件未发生变动时不会重新加载
   */
  private _champSelect(options: { mhSignal: AbortSignal; signal: AbortSignal; force: boolean }) {
    const { mhSignal, signal, force } = options

    const puuids = this.getPuuidsToLoadForPlayers()
    puuids.forEach((puuid) => {
      this._loadPlayerMatchHistory(puuid, {
        signal,
        mhSignal,
        force,
        tag:
          this.settings.matchHistoryTagPreference === 'current'
            ? this._getCurrentGameMatchHistoryTag()
            : 'all',
        count: this.settings.matchHistoryLoadCount,
        useSgpApi: this.settings.matchHistoryUseSgpApi
      })
      this._loadPlayerSummoner(puuid, { signal, force })
      this._loadPlayerRankedStats(puuid, { signal, force })
      this._loadPlayerSavedInfo(puuid, {
        signal,
        force,
        useSgpApi: this.settings.matchHistoryUseSgpApi
      })
      this._loadPlayerChampionMasteries(puuid, { signal, force })
    })
  }

  /** 目前实现同 #._champSelect */
  private _inGame(options: { mhSignal: AbortSignal; signal: AbortSignal; force: boolean }) {
    const { mhSignal, signal, force } = options

    const puuids = this.getPuuidsToLoadForPlayers()
    puuids.forEach((puuid) => {
      this._loadPlayerMatchHistory(puuid, {
        signal,
        mhSignal,
        force,
        tag:
          this.settings.matchHistoryTagPreference === 'current'
            ? this._getCurrentGameMatchHistoryTag()
            : 'all',
        count: this.settings.matchHistoryLoadCount,
        useSgpApi: this.settings.matchHistoryUseSgpApi
      })
      this._loadPlayerSummoner(puuid, { signal, force })
      this._loadPlayerRankedStats(puuid, { signal, force })
      this._loadPlayerSavedInfo(puuid, {
        signal,
        force,
        useSgpApi: this.settings.matchHistoryUseSgpApi
      })
      this._loadPlayerChampionMasteries(puuid, { signal, force })
    })
  }

  private _clearAndReload() {
    if (this._controller) {
      this._controller.abort()
      this._controller = null
    }

    if (this._mhController) {
      this._mhController.abort()
      this._mhController = null
    }

    this.state.clear()
    this._ipc.sendEvent(OngoingGameMain.id, 'clear')

    this._controller = new AbortController()
    this._mhController = new AbortController()

    if (this.state.queryStage.phase === 'champ-select') {
      this._champSelect({
        mhSignal: this._mhController.signal,
        signal: this._controller.signal,
        force: true
      })
    } else if (this.state.queryStage.phase === 'in-game') {
      this._inGame({
        mhSignal: this._mhController.signal,
        signal: this._controller.signal,
        force: true
      })
    }
  }

  private getPuuidsToLoadForPlayers() {
    if (this.state.queryStage.phase === 'unavailable') {
      return []
    }

    if (this.state.queryStage.phase === 'champ-select') {
      const session = this._lc.data.champSelect.session
      if (!session) {
        return []
      }

      const m = session.myTeam.filter((p) => p.puuid && p.puuid !== EMPTY_PUUID).map((t) => t.puuid)

      const t = session.theirTeam
        .filter((p) => p.puuid && p.puuid !== EMPTY_PUUID)
        .map((t) => t.puuid)

      return [...m, ...t]
    } else if (this.state.queryStage.phase === 'in-game') {
      const session = this._lc.data.gameflow.session

      if (!session) {
        return []
      }

      const m = session.gameData.teamOne
        .filter((p) => p.puuid && p.puuid !== EMPTY_PUUID)
        .map((t) => t.puuid)

      const t = session.gameData.teamTwo
        .filter((p) => p.puuid && p.puuid !== EMPTY_PUUID)
        .map((t) => t.puuid)

      return [...m, ...t]
    }

    return []
  }

  private async _loadGameTimeline(
    gameIds: number[],
    options: {
      force?: boolean
      useSgpApi?: boolean
      signal?: AbortSignal
    } = {}
  ) {
    const { force, signal, useSgpApi } = options

    const isAbleToUseSgpApi =
      useSgpApi && this._sgp.state.availability.serversSupported.matchHistory

    const loadGameTimeline = async (gameId: number) => {
      const current = this.state.gameTimeline[gameId]

      if (!force && current && current.source === (isAbleToUseSgpApi ? 'sgp' : 'lcu')) {
        this._log.debug('Game timeline query condition not changed, skip', gameId)
        return
      }

      const cached = this._gameTimelineLruMap.get(gameId)
      if (cached && cached.source === (isAbleToUseSgpApi ? 'sgp' : 'lcu')) {
        this._log.info('Game timeline hit cache', gameId)
        runInAction(() => {
          this.state.gameTimeline[gameId] = cached
        })
        this._ipc.sendEvent(OngoingGameMain.id, 'game-timeline-loaded', gameId, cached)
        return
      }

      if (isAbleToUseSgpApi) {
        this._log.debug('Load game timeline: SGP API', gameId)

        const res = await this._queue
          .add(() => this._sgp.getTimelineLcuFormat(gameId), {
            signal,
            priority: OngoingGameMain.LOADING_PRIORITY.GAME_TIMELINE
          })
          .catch((error) => this._handleError(error, 'game-timeline', gameId))

        if (res) {
          this._log.debug('Game timeline loaded: SGP', gameId)

          const toBeLoaded = {
            data: res,
            source: 'sgp' as 'sgp' | 'lcu'
          }

          this._gameTimelineLruMap.set(gameId, toBeLoaded)
          runInAction(() => {
            this.state.gameTimeline[gameId] = toBeLoaded
          })
          this._ipc.sendEvent(OngoingGameMain.id, 'game-timeline-loaded', gameId, toBeLoaded)
        }
      } else {
        this._log.debug('Load game timeline: LCU API', gameId)

        const res = await this._queue
          .add(() => this._lc.api.matchHistory.getTimeline(gameId), {
            signal,
            priority: OngoingGameMain.LOADING_PRIORITY.GAME_TIMELINE
          })
          .catch((error) => this._handleError(error, 'game-timeline', gameId))

        if (res) {
          this._log.debug('Game timeline loaded: LCU', gameId)

          const toBeLoaded = {
            data: res.data,
            source: 'lcu' as 'sgp' | 'lcu'
          }

          this._gameTimelineLruMap.set(gameId, toBeLoaded)
          runInAction(() => {
            this.state.gameTimeline[gameId] = toBeLoaded
          })
          this._ipc.sendEvent(OngoingGameMain.id, 'game-timeline-loaded', gameId, toBeLoaded)
        }
      }
    }

    await Promise.allSettled(gameIds.map((g) => loadGameTimeline(g)))
  }

  private async _loadAdditionalGame(
    gameIds: number[],
    options: {
      force?: boolean
      useSgpApi?: boolean
      signal?: AbortSignal
    } = {}
  ) {
    const { force, signal, useSgpApi } = options

    const isAbleToUseSgpApi =
      useSgpApi && this._sgp.state.availability.serversSupported.matchHistory

    const loadGame = async (gameId: number) => {
      const current = this.state.additionalGame[gameId]

      if (!force && current && current.source === (isAbleToUseSgpApi ? 'sgp' : 'lcu')) {
        this._log.debug('Game timeline query condition not changed, skip', gameId)
        return
      }

      const cached = this._gameLruMap.get(gameId)
      if (cached && cached.source === (isAbleToUseSgpApi ? 'sgp' : 'lcu')) {
        this._log.info('Additional game info hit cache', gameId)
        runInAction(() => {
          this.state.additionalGame[gameId] = cached
        })
        this._ipc.sendEvent(OngoingGameMain.id, 'additional-game-loaded', gameId, cached)
        return
      }

      if (isAbleToUseSgpApi) {
        this._log.info('Load additional game info: SGP API', gameId)

        const res = await this._queue
          .add(() => this._sgp.getGameSummaryLcuFormat(gameId), {
            signal,
            priority: OngoingGameMain.LOADING_PRIORITY.ADDITIONAL_GAME
          })
          .catch((error) => this._handleError(error, 'additional-game', gameId))

        if (res) {
          this._log.debug('Additional game info loaded: SGP', gameId)

          const toBeLoaded = {
            data: res,
            source: 'sgp' as 'sgp' | 'lcu'
          }

          this._gameLruMap.set(gameId, toBeLoaded)
          runInAction(() => {
            this.state.additionalGame[gameId] = toBeLoaded
          })
          this._ipc.sendEvent(OngoingGameMain.id, 'additional-game-loaded', gameId, toBeLoaded)
        }
      } else {
        this._log.info('Load additional game info: LCU API', gameId)

        const res = await this._queue
          .add(() => this._lc.api.matchHistory.getGame(gameId), {
            signal,
            priority: OngoingGameMain.LOADING_PRIORITY.ADDITIONAL_GAME
          })
          .catch((error) => this._handleError(error, 'additional-game', gameId))

        if (res) {
          this._log.debug('Additional game info loaded: LCU', gameId)

          const toBeLoaded = {
            data: res.data,
            source: 'lcu' as 'sgp' | 'lcu'
          }

          this._gameLruMap.set(gameId, toBeLoaded)
          runInAction(() => {
            this.state.additionalGame[gameId] = toBeLoaded
          })
          this._ipc.sendEvent(OngoingGameMain.id, 'additional-game-loaded', gameId, toBeLoaded)
        }
      }
    }

    await Promise.allSettled(gameIds.map((g) => loadGame(g)))
  }

  private async _loadPlayerMatchHistory(
    puuid: string,
    options: {
      signal?: AbortSignal
      mhSignal?: AbortSignal
      tag?: string
      count?: number
      force?: boolean
      useSgpApi?: boolean
      priority?: number
    } = {}
  ) {
    let { count = 20, signal, mhSignal, tag, force, useSgpApi } = options

    const isAbleToUseSgpApi =
      useSgpApi && this._sgp.state.availability.serversSupported.matchHistory

    const current = this.state.matchHistory[puuid]
    if (
      !force && // 在不强制更新的情况下
      current && // 在存在值的情况下
      current.targetCount === count && // 必要条件之一: 加载数量没有变化
      current.source === (isAbleToUseSgpApi ? 'sgp' : 'lcu') && // 必要条件之一: 数据来源没有变化
      (!isAbleToUseSgpApi || (tag === 'all' ? undefined : tag) === current.tag) // 必要条件之一: SGP API 时, tag 也必须一致 (LCU API 将忽略 tag, 本来也没用)
    ) {
      // 以上不需要重新加载的前提, 是假设在一个对局期间, 这些数据都不会发生变化
      // ) 事实上在一个对局期间, 大部分情况是不会发生变化的
      this._log.debug('Player match history query condition not changed, skip', puuid)
      return
    }

    if (isAbleToUseSgpApi) {
      this._log.info('Load player match history: SGP API', puuid)

      if (tag) {
        if (tag === 'all' || !OngoingGameMain.SAFE_TAGS.has(tag)) {
          tag = undefined
          this.state.setMatchHistoryTag('all')
        } else {
          this.state.setMatchHistoryTag(tag)
        }
      }

      this.state.setMatchHistoryLoadingState(puuid, 'loading')
      const data = await this._mhQueue
        .add(() => this._sgp.getMatchHistoryLcuFormat(puuid, 0, count, tag), {
          signal: mhSignal,
          priority: options.priority ?? OngoingGameMain.LOADING_PRIORITY.MATCH_HISTORY
        })
        .catch((error) => this._handleMatchHistoryError(error, puuid))

      if (!data) {
        return
      }

      this._log.debug('Load player match history completed: SGP API', puuid)

      this._loadGameTimeline(
        data.games.games.map((g) => g.gameId).slice(0, this.settings.gameTimelineLoadCount),
        { signal, force, useSgpApi }
      )

      const toBeLoaded = {
        data: data.games.games,
        targetCount: count,
        source: 'sgp' as 'sgp' | 'lcu',
        tag
      }

      runInAction(() => (this.state.matchHistory[puuid] = toBeLoaded))
      this._ipc.sendEvent(OngoingGameMain.id, 'match-history-loaded', puuid, toBeLoaded)
      this.state.setMatchHistoryLoadingState(puuid, 'loaded')
    } else {
      this._log.info('Load player match history: LCU API', puuid)

      this.state.setMatchHistoryLoadingState(puuid, 'loading')
      const res = await this._queue
        .add(() => this._lc.api.matchHistory.getMatchHistory(puuid, 0, count - 1), {
          signal: mhSignal,
          priority: options.priority ?? OngoingGameMain.LOADING_PRIORITY.MATCH_HISTORY
        })
        .catch((error) => this._handleMatchHistoryError(error, puuid))

      if (!res) {
        return
      }

      const detailedGameMap: Record<number, Game> = {}
      const loadGame = async (gameId: number) => {
        if (this._gameLruMap.has(gameId)) {
          detailedGameMap[gameId] = this._gameLruMap.get(gameId)!.data
          return
        }

        const res = await this._queue
          .add(() => this._lc.api.matchHistory.getGame(gameId), {
            signal, // 使用公用的 signal
            priority: Infinity // 容易成功的将被优先加载
          })
          .catch((error) => this._handleMatchHistoryError(error, puuid))

        if (res) {
          this._gameLruMap.set(gameId, {
            source: 'lcu',
            data: res.data
          })
          detailedGameMap[gameId] = res.data
        }
      }

      this._loadGameTimeline(
        res.data.games.games.map((g) => g.gameId).slice(0, this.settings.gameTimelineLoadCount),
        { signal, force, useSgpApi }
      )

      await Promise.allSettled(res.data.games.games.map((g) => loadGame(g.gameId)))

      this._log.debug('Load player match history completed: LCU API', puuid)

      const games = res.data.games.games.map((g) => detailedGameMap[g.gameId] || g)

      const toBeLoaded = {
        data: games,
        targetCount: count,
        source: 'lcu' as 'sgp' | 'lcu'
      }

      runInAction(() => (this.state.matchHistory[puuid] = toBeLoaded))
      this._ipc.sendEvent(OngoingGameMain.id, 'match-history-loaded', puuid, toBeLoaded)
      this.state.setMatchHistoryLoadingState(puuid, 'loaded')
    }
  }

  private async _loadPlayerSummoner(
    puuid: string,
    options: {
      signal?: AbortSignal
      force?: boolean
      priority?: number
    } = {}
  ) {
    const { signal, force } = options

    // 如果不是强制更新, 并且已经有数据, 那么就不再加载
    if (!force && this.state.summoner[puuid]) {
      this._log.debug('Summoner info already exists', puuid)
      return
    }

    const res = await this._queue
      .add(() => this._lc.api.summoner.getSummonerByPuuid(puuid), {
        signal,
        priority: options.priority ?? OngoingGameMain.LOADING_PRIORITY.SUMMONER
      })
      .catch((error) => this._handleError(error, 'summoner', puuid))

    if (!res) {
      return
    }

    this._log.debug('Load summoner info completed', puuid)

    const data = res.data
    const toBeLoaded = { data, source: 'lcu' as 'sgp' | 'lcu' }
    runInAction(() => (this.state.summoner[puuid] = toBeLoaded))
    this._ipc.sendEvent(OngoingGameMain.id, 'summoner-loaded', puuid, toBeLoaded)
  }

  private async _loadPlayerSavedInfo(
    puuid: string,
    options: {
      signal?: AbortSignal
      force?: boolean
      useSgpApi?: boolean
    } = {}
  ) {
    // just used to suppress ts error
    if (!this._lc.state.auth || !this._lc.data.summoner.me) {
      return
    }

    const query = {
      puuid,
      selfPuuid: this._lc.data.summoner.me.puuid,
      region: this._lc.state.auth.region,
      rsoPlatformId: this._lc.state.auth.rsoPlatformId
    }

    const { signal, force, useSgpApi } = options

    if (!force && this.state.savedInfo[puuid]) {
      return
    }

    const res = await this._queue
      .add(() => this._saved.querySavedPlayerWithGames(query), {
        signal,
        priority: OngoingGameMain.LOADING_PRIORITY.SAVED_INFO
      })
      .catch((error) => this._handleError(error, 'saved-info', puuid))

    if (!res) {
      return
    }

    this._loadAdditionalGame(
      res.encounteredGames.data.map((c) => c.gameId),
      {
        force,
        signal,
        useSgpApi
      }
    )

    res.tags.forEach((t) => {
      this._loadPlayerSummoner(t.selfPuuid, {
        signal,
        force,
        priority: OngoingGameMain.LOADING_PRIORITY.ADDITIONAL_SUMMONER
      })
    })

    runInAction(() => (this.state.savedInfo[puuid] = res))
    this._ipc.sendEvent(OngoingGameMain.id, 'saved-info-loaded', puuid, res)
  }

  private async _loadPlayerRankedStats(
    puuid: string,
    options: {
      signal?: AbortSignal
      force?: boolean
      priority?: number
    } = {}
  ) {
    const { signal, force } = options

    if (!force && this.state.rankedStats[puuid]) {
      this._log.debug('Ranked stats already exists', puuid)
      return
    }

    const res = await this._mhQueue
      .add(() => this._lc.api.ranked.getRankedStats(puuid), {
        signal,
        priority: options.priority ?? OngoingGameMain.LOADING_PRIORITY.RANKED_STATS
      })
      .catch((error) => this._handleError(error, 'ranked-stats', puuid))

    if (!res) {
      return
    }

    this._log.debug('Load ranked stats completed', puuid)

    const data = res.data
    const toBeLoaded = { data, source: 'lcu' as 'sgp' | 'lcu' }
    runInAction(() => (this.state.rankedStats[puuid] = toBeLoaded))
    this._ipc.sendEvent(OngoingGameMain.id, 'ranked-stats-loaded', puuid, toBeLoaded)
  }

  private async _loadPlayerChampionMasteries(
    puuid: string,
    options: {
      signal?: AbortSignal
      force?: boolean
      priority?: number
    } = {}
  ) {
    const { signal, force } = options

    if (!force && this.state.championMastery[puuid]) {
      this._log.debug('Champion mastery already exists', puuid)
      return
    }

    const res = await this._mhQueue
      .add(() => this._lc.api.championMastery.getPlayerChampionMastery(puuid), {
        signal,
        priority: options.priority ?? OngoingGameMain.LOADING_PRIORITY.CHAMPION_MASTERY
      })
      .catch((error) => this._handleError(error, 'champion-mastery', puuid))

    if (!res) {
      return
    }

    this._log.debug('Load champion mastery completed', puuid)

    const data = res.data

    const simplifiedMastery = data
      .map((m) => ({
        championId: m.championId,
        championLevel: m.championLevel,
        championPoints: m.championPoints,
        milestoneGrades: m.milestoneGrades
      }))
      .reduce((obj, cur) => {
        obj[cur.championId] = cur
        return obj
      }, {} as any)

    const toBeLoaded = { data: simplifiedMastery, source: 'lcu' as 'sgp' | 'lcu' }
    runInAction(() => (this.state.championMastery[puuid] = toBeLoaded))
    this._ipc.sendEvent(OngoingGameMain.id, 'champion-mastery-loaded', puuid, toBeLoaded)
  }

  private _handleIpcCall() {
    this._ipc.onCall(OngoingGameMain.id, 'getAll', () => {
      const matchHistory = toJS(this.state.matchHistory)
      const summoner = toJS(this.state.summoner)
      const rankedStats = toJS(this.state.rankedStats)
      const savedInfo = toJS(this.state.savedInfo)
      const championMastery = toJS(this.state.championMastery)
      const gameTimeline = toJS(this.state.additionalGame)
      const additionalGames = toJS(this.state.additionalGame)

      return {
        matchHistory,
        summoner,
        rankedStats,
        savedInfo,
        championMastery,
        gameTimeline,
        additionalGames
      }
    })

    this._ipc.onCall(OngoingGameMain.id, 'setMatchHistoryTag', (_, tag: string) => {
      if (OngoingGameMain.SAFE_TAGS.has(tag) || tag === 'all') {
        this.state.setMatchHistoryTag(tag)
        this._debouncedUpdateMatchHistoryFn()
      }
    })

    this._ipc.onCall(OngoingGameMain.id, 'reload', () => {
      this._clearAndReload()
    })
  }

  private _calcTeamUp() {
    if (!this.state.teams) {
      return null
    }

    const games = Object.values(this.state.matchHistory)
      .map((m) => m.data)
      .flat()

    if (!games.length) {
      return null
    }

    // 统计所有目前游戏中的每个队伍，并且将这些队伍分别视为一个独立的个体，使用 `${游戏ID}|${队伍ID}` 进行唯一区分
    const teamSides = new Map<string, string[]>()
    for (const game of games) {
      const mode = game.gameMode

      // participantId -> puuid
      const participantsMap = game.participantIdentities.reduce(
        (obj, current) => {
          obj[current.participantId] = current.player.puuid
          return obj
        },
        {} as Record<string, string>
      )

      let grouped: { teamId: number; puuid: string }[]

      // 对于竞技场模式，在战绩接口中只有一个队伍。如果要区分小队，需要使用 subteamPlacement 或 subteamId 字段
      if (mode === 'CHERRY') {
        grouped = game.participants.map((p) => ({
          teamId: p.stats.subteamPlacement, // 取值范围是 1, 2, 3, 4, 这个实际上也是最终队伍排名
          puuid: participantsMap[p.participantId]
        }))
      } else {
        // 对于其他模式，按照两队式计算
        grouped = game.participants.map((p) => ({
          teamId: p.teamId,
          puuid: participantsMap[p.participantId]
        }))
      }

      // teamId -> puuid[]，这个记录的是这条战绩中的
      const teamPlayersMap = grouped.reduce(
        (obj, current) => {
          if (obj[current.teamId]) {
            obj[current.teamId].push(current.puuid)
          } else {
            obj[current.teamId] = [current.puuid]
          }
          return obj
        },
        {} as Record<string, string[]>
      )

      // sideId -> puuid[]，按照队伍区分。
      Object.entries(teamPlayersMap).forEach(([teamId, players]) => {
        const sideId = `${game.gameId}|${teamId}`
        if (teamSides.has(sideId)) {
          return
        }
        teamSides.set(sideId, players)
      })
    }

    const matches = Array.from(teamSides).map(([id /* sideId */, players]) => ({ id, players }))

    // key: teamSide, values: { players: string[], times: number }[]
    const result = Object.entries(this.state.teams).reduce(
      (obj, [team, teamPlayers]) => {
        obj[team] = calculateTogetherTimes(matches, teamPlayers, this.settings.premadeTeamThreshold)

        return obj
      },
      {} as Record<
        string,
        {
          players: string[]
          times: number
        }[]
      >
    )

    // teamSide -> players[][]
    const combinedGroups: Record<string, string[][]> = {}

    for (const [team, playerGroups] of Object.entries(result)) {
      const groups = playerGroups.map((pg) => pg.players)
      combinedGroups[team] = removeOverlappingSubsets(groups) as string[][]
    }

    return combinedGroups
  }

  private _calcAnalysis() {
    if (!this.state.teams) {
      return null
    }

    try {
      const playerAnalyses: Record<string, MatchHistoryGamesAnalysisAll> = {}

      for (const [puuid, matchHistory] of Object.entries(this.state.matchHistory)) {
        if (!matchHistory) {
          continue
        }

        const mappedGameTimeline = Object.entries(this.state.additionalGame).reduce(
          (obj, [gameIdStr, data]) => {
            obj[gameIdStr] = data.data
            return obj
          },
          {} as Record<number, GameTimeline>
        )

        // console.log('mappedGameTimeline', mappedGameTimeline)

        const analysis = analyzeMatchHistory(
          matchHistory.data.map((g) => ({ game: g, isDetailed: true })),
          puuid,
          undefined,
          mappedGameTimeline
        )
        if (analysis) {
          playerAnalyses[puuid] = analysis
        }
      }

      const teamAnalyses: Record<string, MatchHistoryGamesAnalysisTeamSide> = {}

      for (const [sideId, puuids] of Object.entries(this.state.teams)) {
        const teamPlayerAnalyses = puuids.map((p) => playerAnalyses[p]).filter(Boolean)
        const teamAnalysis = analyzeTeamMatchHistory(teamPlayerAnalyses)
        if (teamAnalysis) {
          teamAnalyses[sideId] = teamAnalysis
        }
      }
      return {
        players: playerAnalyses,
        teams: teamAnalyses
      }
    } catch (error) {
      this._log.warn('Error calculating match history', error)
      return null
    }
  }

  private _handleCalculation() {
    // 重新计算战绩信息
    this._mobx.reaction(
      () => [
        ...Object.values(this.state.matchHistory),
        ...Object.values(this.state.additionalGame)
      ],
      (_changedV) => {
        this.state.setPlayerStats(this._calcAnalysis())
      },
      { delay: 200, equals: comparer.shallow }
    )

    // 重新计算预组队
    this._mobx.reaction(
      () => [Object.values(this.state.matchHistory), this.settings.premadeTeamThreshold] as const,
      ([_changedV, _threshold]) => {
        this.state.setInferredPremadeTeams(this._calcTeamUp() || {})
      },
      { delay: 200, equals: comparer.shallow }
    )
  }

  private async _handleEndOfGameSave() {
    const isInEndOfGame = computed(() => {
      return (
        this._lc.data.gameflow.phase === 'EndOfGame' ||
        this._lc.data.gameflow.phase === 'PreEndOfGame'
      )
    })

    this._mobx.reaction(
      () => isInEndOfGame.get(),
      async (yes) => {
        if (yes) {
          if (
            !this._lc.state.auth ||
            !this._lc.data.summoner.me ||
            !this.state.queryStage.gameInfo
          ) {
            return
          }

          const players = Object.values(this.state.teams || {}).flat()

          if (!players.includes(this._lc.data.summoner.me.puuid)) {
            this._log.info('Current player not in this game, skip recording')
            return
          }

          const filteredPlayers = players.filter((p) => p !== this._lc.data.summoner.me?.puuid)

          for (const player of filteredPlayers) {
            await this._saved.saveEncounteredGame({
              gameId: this.state.queryStage.gameInfo.gameId,
              puuid: player,
              region: this._lc.state.auth.region,
              rsoPlatformId: this._lc.state.auth.rsoPlatformId,
              selfPuuid: this._lc.data.summoner.me.puuid,
              queueType: this.state.queryStage.gameInfo.queueType
            })

            this._log.info(`Save game info: ${this.state.queryStage.gameInfo.gameId}`)
            await this._saved.saveSavedPlayer({
              encountered: true,
              puuid: player,
              selfPuuid: this._lc.data.summoner.me.puuid,
              region: this._lc.state.auth.region,
              rsoPlatformId: this._lc.state.auth.rsoPlatformId
            })
            this._log.info(`Save player info: ${player}`)
          }
        }
      }
    )
  }

  /**
   * 或许有人需要这个
   */
  private _handleRemindTaggedPlayers() {
    let reminded: string[] = []

    const itsTimeToSend = computed(() => {
      if (!this._lc.data.chat.conversations.championSelect) {
        return null
      }

      return this._lc.data.chat.conversations.championSelect.id
    })

    const playersToSend = computed(
      () => {
        return Object.entries(this.state.savedInfo)
          .map(([puuid, info]) => {
            if (!info.tag) {
              return null
            }

            const summoner = this.state.summoner[puuid]
            if (!summoner) {
              return null
            }

            return {
              puuid,
              name: `${summoner.data.gameName}#${summoner.data.tagLine}`,
              tag: info.tag
            }
          })
          .filter((p) => p !== null)
      },
      {
        equals: (a, b) => {
          const aPuuids = a.map((p) => p.puuid)
          const bPuuids = b.map((p) => p.puuid)
          return comparer.shallow(aPuuids, bPuuids)
        }
      }
    )

    this._mobx.reaction(
      () => itsTimeToSend.get(),
      (id) => {
        if (!id) {
          reminded = []
          return
        }
      }
    )

    this._mobx.reaction(
      () => [playersToSend.get(), itsTimeToSend.get()] as const,
      ([players, roomId]) => {
        if (!roomId) {
          return
        }

        for (const player of players) {
          if (reminded.includes(player.puuid)) {
            continue
          }

          this._lc.api.chat
            .chatSend(
              roomId,
              `[${i18next.t('ongoing-game-main.taggedPlayer')}: ${player.name}]: \n${player.tag}`,
              'celebration'
            )
            .catch(() => {})
          reminded.push(player.puuid)
        }
      }
    )
  }

  private _handleError(e: any, type = '', info?: any) {
    if (e instanceof Error && e.name === 'AbortError') {
      this._log.info('Task aborted', type)
      return
    }

    if (isAxiosError(e) && e.response?.status === 404) {
      this._log.info('Target not found', type, info)
      return
    }

    this._log.warn('Error loading', e, type)
    return
  }

  private _handleMatchHistoryError(e: any, puuid: string) {
    if (e instanceof Error && e.name === 'AbortError') {
      this.state.setMatchHistoryLoadingState(puuid, 'aborted')
      return
    }

    this._log.warn('Error loading match history', e, puuid)
    this.state.setMatchHistoryLoadingState(puuid, 'error')
    return
  }
}
