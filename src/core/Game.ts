import { Player } from './Player';
import { Enemy } from './Enemy';
import { Bullet } from './Bullet';
import { Boss } from './Boss';
import { ScatterBoss } from './ScatterBoss';
import { LaserBoss } from './LaserBoss.ts';
import { TrackingBoss } from './TrackingBoss';
import { normalizeHealth } from './health';
import { ChargeSystem } from '../systems/ChargeSystem';
import { ComboSystem } from '../systems/ComboSystem';
import { ScoreSystem } from '../systems/ScoreSystem';
import { WaveSystem } from '../systems/WaveSystem';
import { AIController } from '../systems/AIController';
import { GameConfig, PlayerSide, AircraftType, GameMode } from '../entities/types';
import type { PolicyDecisionProvider } from '../systems/policy/types';

type ExpandingField = {
  side: PlayerSide;
  ownerSide: PlayerSide;
  x: number;
  y: number;
  elapsed: number;
  duration: number;
  targetRadius: number;
  skillTokenId?: number;
};

type SkillLifecycle = {
  id: number;
  side: PlayerSide;
  activeEntities: number;
  pendingCallbacks: number;
};

type ScoreTrendState = {
  elapsedMs: number;
  lastVisibleScore: number;
  cumulativePenalty: number;
  penaltyEvents: number;
};

export type GameRuntimeAdapter = {
  getDevicePixelRatio: () => number;
  getViewportSize: () => { width: number; height: number };
  now: () => number;
  dateNow: () => number;
  setTimeout: (callback: () => void, delayMs: number) => number;
  clearTimeout: (id: number) => void;
  requestAnimationFrame: (callback: (time: number) => void) => number;
  cancelAnimationFrame: (id: number) => void;
  addWindowListener: (type: 'keydown' | 'keyup', listener: (e: KeyboardEvent) => void) => void;
  removeWindowListener: (type: 'keydown' | 'keyup', listener: (e: KeyboardEvent) => void) => void;
  createElementNS: (ns: string, qualifiedName: string) => Element | null;
  createElement: (tagName: 'a' | 'canvas') => HTMLElement | HTMLCanvasElement | null;
  createObjectURL: (blob: Blob) => string | null;
  revokeObjectURL: (url: string) => void;
  advanceTime?: (deltaMs: number) => void;
  // Optional headless file save hook (Node runtime should implement)
  saveFile?: (content: string, filename: string, mimeType?: string) => void;
};

export class Game {
  private ctx: any;
  private headless = false;
  private svgOverlay: SVGSVGElement | null = null;
  private readonly dpr: number;
  private lastTime = 0;
  private accumulator = 0;
  private readonly fixedDeltaTime = 1000 / 60;
  private animationFrameId = 0;
  private running = false;
  
  private player1: Player;
  private player2: Player | null = null;
  private aiControllerLeft: AIController | null = null;
  private aiControllerRight: AIController | null = null;
  
  private enemies: Enemy[] = [];
  private bullets: Bullet[] = [];
  private boss: Boss | null = null;
  
  private chargeSystem1: ChargeSystem;
  private chargeSystem2: ChargeSystem | null = null;
  private comboSystem1: ComboSystem;
  private comboSystem2: ComboSystem | null = null;
  private scoreSystem1: ScoreSystem;
  private scoreSystem2: ScoreSystem | null = null;
  private waveSystem: WaveSystem;

  // In-memory buffer for training events (export as needed)
  public trainingEvents: any[] = [];
  
  private gameMode: GameMode = 'single';
  private aiDifficulty: 'easy' | 'normal' | 'hard' = 'normal';
  private gameOver = false;
  private winnerText = '';
  private readonly keyDownListener = (e: KeyboardEvent) => this.handleKeyDown(e);
  private readonly keyUpListener = (e: KeyboardEvent) => this.handleKeyUp(e);
  private readonly managedTimeoutIds = new Set<number>();
  private listenersAttached = false;
  private nextSkillLifecycleId = 1;
  private skillLifecycles = new Map<number, SkillLifecycle>();
  private activeSkillLifecycleBySide: Record<PlayerSide, number | null> = { left: null, right: null };
  
  private readonly SCREEN_WIDTH: number;
  private readonly SCREEN_HEIGHT: number;
  private readonly MARGIN = 0.1;
  private expandingFields: ExpandingField[] = [];
  private leftBackdropCache: HTMLCanvasElement | null = null;
  private rightBackdropCache: HTMLCanvasElement | null = null;
  private dividerCache: HTMLCanvasElement | null = null;
  private static episodeCounter = 0;
  private currentEpisode = 0;
  private currentMatchId = '';
  private simulationFrame = 0;
  private matchStartTimestamp = 0;
  private readonly runtime: GameRuntimeAdapter;
  private readonly runSeed: string;
  private readonly agentIds: Record<PlayerSide, string>;
  private readonly agentPolicies: Partial<Record<PlayerSide, PolicyDecisionProvider | null>>;
  private readonly trainingConfig: Record<string, unknown>;
  private readonly scoreTrendWindowMs = 5000;
  private readonly scoreTrendBaseGain = 8;
  private readonly scoreTrendGrowthStep = 240;
  private readonly scoreTrendMaxGain = 18;
  private readonly scoreTrendPenaltyScale = 1.35;
  private readonly finalScoreRewardScale = 0.08;
  private readonly finalScoreRewardCap = 180;
  private scoreTrendState: Record<PlayerSide, ScoreTrendState> = {
    left: { elapsedMs: 0, lastVisibleScore: 0, cumulativePenalty: 0, penaltyEvents: 0 },
    right: { elapsedMs: 0, lastVisibleScore: 0, cumulativePenalty: 0, penaltyEvents: 0 },
  };

  private static createBrowserRuntimeAdapter(): GameRuntimeAdapter {
    return {
      getDevicePixelRatio: () => Math.max(1, (globalThis as any).window?.devicePixelRatio ?? 1),
      getViewportSize: () => ({
        width: Math.max(320, (globalThis as any).window?.innerWidth ?? 1200),
        height: Math.max(240, (globalThis as any).window?.innerHeight ?? 800),
      }),
      now: () => (globalThis as any).performance?.now?.() ?? Date.now(),
      dateNow: () => Date.now(),
      setTimeout: (callback, delayMs) => (globalThis as any).window?.setTimeout(callback, delayMs) ?? setTimeout(callback, delayMs) as unknown as number,
      clearTimeout: (id) => {
        if ((globalThis as any).window?.clearTimeout) {
          (globalThis as any).window.clearTimeout(id);
          return;
        }
        clearTimeout(id as unknown as number);
      },
      requestAnimationFrame: (callback) => {
        if ((globalThis as any).window?.requestAnimationFrame) {
          return (globalThis as any).window.requestAnimationFrame(callback);
        }
        return setTimeout(() => callback(Date.now()), 16) as unknown as number;
      },
      cancelAnimationFrame: (id) => {
        if ((globalThis as any).window?.cancelAnimationFrame) {
          (globalThis as any).window.cancelAnimationFrame(id);
          return;
        }
        clearTimeout(id as unknown as number);
      },
      addWindowListener: (type, listener) => {
        (globalThis as any).window?.addEventListener?.(type, listener);
      },
      removeWindowListener: (type, listener) => {
        (globalThis as any).window?.removeEventListener?.(type, listener);
      },
      createElementNS: (ns, qualifiedName) => {
        return (globalThis as any).document?.createElementNS?.(ns, qualifiedName) ?? null;
      },
      createElement: (tagName) => {
        return (globalThis as any).document?.createElement?.(tagName) ?? null;
      },
      createObjectURL: (blob) => {
        return (globalThis as any).URL?.createObjectURL?.(blob) ?? null;
      },
      revokeObjectURL: (url) => {
        (globalThis as any).URL?.revokeObjectURL?.(url);
      },
    };
  }
  
  constructor(canvas: HTMLCanvasElement | null, config: Partial<GameConfig> = {}) {
    this.runtime = (config as any).runtime ?? Game.createBrowserRuntimeAdapter();
    this.gameMode = config.mode ?? 'single';
    this.aiDifficulty = config.difficulty ?? 'normal';
    this.dpr = this.runtime.getDevicePixelRatio();
    this.runSeed = String(config.seed ?? this.runtime.dateNow());
    this.agentIds = {
      left: config.agentIds?.left ?? `agent-left-${this.aiDifficulty}`,
      right: config.agentIds?.right ?? `agent-right-${this.aiDifficulty}`,
    };
    this.agentPolicies = {
      left: config.agentPolicies?.left ?? null,
      right: config.agentPolicies?.right ?? null,
    };
    this.trainingConfig = {
      mode: this.gameMode,
      difficulty: this.aiDifficulty,
      player1Aircraft: config.player1Aircraft ?? 'scatter',
      player2Aircraft: config.player2Aircraft ?? 'scatter',
      ...(config.trainingConfig ?? {}),
    };

    // 缩小默认游戏画面并限制最大尺寸，避免过大画面导致敌人分布过稀
    const MAX_WIDTH = 1200;
    const MAX_HEIGHT = 800;
    const viewport = this.runtime.getViewportSize();
    this.SCREEN_WIDTH = Math.min(viewport.width * 0.8, MAX_WIDTH);
    this.SCREEN_HEIGHT = Math.min(viewport.height * 0.8, MAX_HEIGHT);

    this.headless = !!(config as any).headless || !canvas;

    if (!this.headless && canvas) {
      this.ctx = canvas.getContext('2d')!;

      canvas.style.width = `${this.SCREEN_WIDTH}px`;
      canvas.style.height = `${this.SCREEN_HEIGHT}px`;
      canvas.width = Math.floor(this.SCREEN_WIDTH * this.dpr);
      canvas.height = Math.floor(this.SCREEN_HEIGHT * this.dpr);
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.ctx.imageSmoothingEnabled = true;

      // create SVG overlay aligned on top of the canvas for player rendering
      const container = canvas.parentElement as HTMLElement | null;
      if (container) {
        const svgNS = 'http://www.w3.org/2000/svg';
        const svg = this.runtime.createElementNS(svgNS, 'svg') as SVGSVGElement | null;
        if (svg) {
          svg.setAttribute('width', String(this.SCREEN_WIDTH));
          svg.setAttribute('height', String(this.SCREEN_HEIGHT));
          svg.style.width = `${this.SCREEN_WIDTH}px`;
          svg.style.height = `${this.SCREEN_HEIGHT}px`;
          svg.style.position = 'absolute';
          svg.style.left = '0';
          svg.style.top = '0';
          svg.style.pointerEvents = 'none';
          svg.style.zIndex = '5';
          container.appendChild(svg);
          this.svgOverlay = svg;
        }
      }
    } else {
      // Headless mode: use a lightweight stub ctx and skip DOM wiring
      this.ctx = {};
    }

    this.chargeSystem1 = new ChargeSystem();
    this.comboSystem1 = new ComboSystem();
    this.scoreSystem1 = new ScoreSystem();
    this.waveSystem = new WaveSystem(this);
    
    this.player1 = new Player(
      this.SCREEN_WIDTH * (0.25 - this.MARGIN / 2),
      this.SCREEN_HEIGHT * 0.7,
      'left',
      this.chargeSystem1,
      this.comboSystem1,
      config.player1Aircraft ?? 'scatter',
      undefined
    );
    this.player1.setFocusEnabled(this.gameMode === 'single');

    this.chargeSystem2 = new ChargeSystem();
    this.comboSystem2 = new ComboSystem();
    this.scoreSystem2 = new ScoreSystem();
    this.player2 = new Player(
      this.SCREEN_WIDTH * (0.75 - this.MARGIN / 2),
      this.SCREEN_HEIGHT * 0.7,
      'right',
      this.chargeSystem2,
      this.comboSystem2,
      config.player2Aircraft ?? 'scatter',
      undefined
    );
    this.player2.setFocusEnabled(false);

    this.rebuildAIControllers();
    this.resetMatchMetadata();
    
    // logging disabled
  }
  
  start() {
    if (this.running) return;
    this.running = true;
    this.setupEventListeners();

    if (this.animationFrameId) {
      this.runtime.cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = 0;
    }

    // Ensure a fresh match state on start (protect against restart/resume bugs)
    this.gameOver = false;
    this.winnerText = '';

    // Reset players
    if (this.player1) {
      this.player1.health = 100;
      this.player1.bombs = 2;
      this.player1.movingLeft = false;
      this.player1.movingRight = false;
      this.player1.movingUp = false;
      this.player1.movingDown = false;
      this.player1.resetRoundState();
    }

    if (this.player2) {
      this.player2.health = 100;
      this.player2.bombs = 2;
      this.player2.movingLeft = false;
      this.player2.movingRight = false;
      this.player2.movingUp = false;
      this.player2.movingDown = false;
      this.player2.resetRoundState();
    }

    // Reset systems
    if (this.comboSystem1) this.comboSystem1.reset();
    if (this.comboSystem2) this.comboSystem2.reset();
    if (this.scoreSystem1) this.scoreSystem1.reset();
    if (this.scoreSystem2) this.scoreSystem2.reset();
    if (this.chargeSystem1) this.chargeSystem1.resetCurrentCharge();
    if (this.chargeSystem2) this.chargeSystem2.resetCurrentCharge();

    // Clear entities
    this.enemies = [];
    this.bullets = [];
    this.boss = null;
    this.expandingFields = [];
    this.leftBackdropCache = null;
    this.rightBackdropCache = null;
    this.dividerCache = null;
    this.skillLifecycles.clear();
    this.activeSkillLifecycleBySide = { left: null, right: null };

    // Recreate wave system and AI controller to reset internal counters
    this.waveSystem = new WaveSystem(this);
    this.rebuildAIControllers();
    this.resetMatchMetadata();

    this.lastTime = this.runtime.now();
    this.accumulator = 0;
    if (!this.headless) this.render();
    this.animationFrameId = this.runtime.requestAnimationFrame((t) => this.gameLoop(t));
  }

  step(deltaTime: number) {
    if (!this.running) {
      return;
    }

    this.update(deltaTime);
    this.runtime.advanceTime?.(deltaTime);
  }

  // Append a training event to in-memory buffer. Lightweight and safe to call frequently.
  pushTrainingEvent(ev: any) {
    if (!ev || typeof ev !== 'object') {
      return;
    }

    const normalized = {
      ...ev,
      match_id: ev.match_id ?? this.currentMatchId,
      episode: ev.episode ?? this.currentEpisode,
      frame: ev.frame ?? this.simulationFrame,
      timestamp_ms: ev.timestamp_ms ?? ev.ts ?? this.runtime.dateNow(),
      game_event: ev.game_event ?? 'tick',
      seed: ev.seed ?? this.runSeed,
      run_config: ev.run_config ?? this.trainingConfig,
      agent_id: ev.agent_id ?? (typeof ev.side === 'string' ? this.getAgentId(ev.side as PlayerSide) : undefined),
    };

    this.trainingEvents.push(normalized);

    const maxEvents = 50000;
    if (this.trainingEvents.length > maxEvents) {
      this.trainingEvents.splice(0, this.trainingEvents.length - maxEvents);
    }
  }

  flushTrainingEvents(clearAfterFlush = true): any[] {
    const snapshot = this.trainingEvents.slice();
    if (clearAfterFlush) {
      this.trainingEvents.length = 0;
    }
    return snapshot;
  }

  private rebuildAIControllers() {
    this.aiControllerLeft = null;
    this.aiControllerRight = null;

    if (!this.player2) {
      return;
    }

    if (this.gameMode === 'single') {
      this.aiControllerRight = new AIController(this, this.player2, 'right', this.aiDifficulty, this.agentPolicies.right ?? null);
      return;
    }

    if (this.gameMode === 'selfplay') {
      this.aiControllerLeft = new AIController(this, this.player1, 'left', this.aiDifficulty, this.agentPolicies.left ?? null);
      this.aiControllerRight = new AIController(this, this.player2, 'right', this.aiDifficulty, this.agentPolicies.right ?? null);
    }
  }

  private resetMatchMetadata() {
    Game.episodeCounter += 1;
    this.currentEpisode = Game.episodeCounter;
    this.currentMatchId = this.createMatchId();
    this.simulationFrame = 0;
    this.matchStartTimestamp = this.runtime.dateNow();
    this.trainingEvents.length = 0;
    this.resetScoreTrendTracking();
  }

  private createMatchId(): string {
    const rand = Math.random().toString(36).slice(2, 10);
    return `m_${this.runtime.dateNow().toString(36)}_${rand}`;
  }

  getRunSeed(): string {
    return this.runSeed;
  }

  getRunConfig(): Record<string, unknown> {
    return this.trainingConfig;
  }

  getAgentId(side: PlayerSide): string {
    return this.agentIds[side];
  }

  getTickMetadata(side: PlayerSide) {
    return {
      seed: this.getRunSeed(),
      run_config: this.getRunConfig(),
      agent_id: this.getAgentId(side),
    };
  }

  getTrainingEventsJSONL(): string {
    return this.trainingEvents.map((event) => JSON.stringify(event)).join('\n');
  }

  getTrainingEventsCSV(): string {
    return this.formatTrainingEventsCSV(this.trainingEvents);
  }

  private formatTrainingEventsCSV(rows: any[]): string {
    const headers = [
      'ts', 'side', 'playerCenterX', 'playerCenterY', 'movementScore', 'threat', 'nearbyBulletCount', 'nearbyBullets',
      'chargeMax', 'currentCharge', 'selfHealth', 'opponentHealth', 'bossSide', 'bossHealth', 'bossMaxHealth', 'scenarioTags', 'rareScore',
      'skillRequested', 'skillExecuted', 'fireTargetAvailable', 'fireBlockedReason', 'fireExecuted', 'skillMask', 'movementTargetX', 'movementTargetY'
    ];
    const escapeCell = (value: unknown) => {
      const text = value === undefined || value === null ? '' : String(value);
      if (/[",\n]/.test(text)) {
        return `"${text.replace(/"/g, '""')}"`;
      }
      return text;
    };

    const lines = [headers.join(',')];
    for (const row of rows) {
      const target = row.movementTarget ?? {};
      const playerCenter = row.playerCenter ?? {};
      const boss = row.boss ?? {};
      const nearbyBullets = JSON.stringify(row.nearbyBullets ?? []);
      const scenarioTags = JSON.stringify(row.scenarioTags ?? []);

      lines.push([
        row.ts,
        row.side,
        playerCenter.x ?? '',
        playerCenter.y ?? '',
        row.movementScore,
        row.threat,
        row.nearbyBulletCount,
        nearbyBullets,
        row.chargeMax ?? '',
        row.currentCharge ?? '',
        row.selfHealth ?? '',
        row.opponentHealth ?? '',
        boss.side ?? '',
        boss.health ?? '',
        boss.maxHealth ?? '',
        scenarioTags,
        row.rareScore ?? '',
        row.skillRequested,
        row.skillExecuted,
        row.fireTargetAvailable,
        row.fireBlockedReason,
        row.fireExecuted,
        JSON.stringify(row.skillMask ?? []),
        target.x ?? '',
        target.y ?? '',
      ].map(escapeCell).join(','));
    }

    return lines.join('\n');
  }

  getRareTrainingEvents(): any[] {
    return this.trainingEvents.filter((event) => {
      if (typeof event?.rareScore === 'number' && event.rareScore > 0) {
        return true;
      }

      const tags = Array.isArray(event?.scenarioTags) ? event.scenarioTags : [];
      return tags.some((tag: string) => [
        'high_threat',
        'low_health',
        'opponent_low_health',
        'boss_present',
        'boss_on_my_side',
        'skill2_action',
        'skill3_action',
        'skill4_action',
      ].includes(tag));
    });
  }

  getRareTrainingEventsJSONL(): string {
    return this.getRareTrainingEvents().map((event) => JSON.stringify(event)).join('\n');
  }

  getRareTrainingEventsCSV(): string {
    return this.formatTrainingEventsCSV(this.getRareTrainingEvents());
  }

  downloadTrainingEvents(format: 'jsonl' | 'csv' | 'rare-jsonl' | 'rare-csv' = 'jsonl') {
    const isRare = format.startsWith('rare-');
    const baseFormat = isRare ? format.replace('rare-', '') as 'jsonl' | 'csv' : format;
    const content = baseFormat === 'csv'
      ? (isRare ? this.getRareTrainingEventsCSV() : this.getTrainingEventsCSV())
      : (isRare ? this.getRareTrainingEventsJSONL() : this.getTrainingEventsJSONL());
    const filename = isRare
      ? (baseFormat === 'csv' ? 'training-events-rare.csv' : 'training-events-rare.jsonl')
      : (baseFormat === 'csv' ? 'training-events.csv' : 'training-events.jsonl');
    const mimeType = baseFormat === 'csv' ? 'text/csv;charset=utf-8' : 'application/jsonl;charset=utf-8';

    this.downloadTextAsFile(content, filename, mimeType);
  }

  flushTrainingEventsToDownload(options?: {
    format?: 'jsonl' | 'csv';
    split?: 'none' | 'rare-full';
    clearAfterFlush?: boolean;
  }): string[] {
    const format = options?.format ?? 'jsonl';
    const split = options?.split ?? 'none';
    const clearAfterFlush = options?.clearAfterFlush ?? true;
    const ext = format === 'csv' ? 'csv' : 'jsonl';
    const mimeType = format === 'csv' ? 'text/csv;charset=utf-8' : 'application/jsonl;charset=utf-8';

    const snapshot = this.flushTrainingEvents(clearAfterFlush);
    const ts = this.runtime.dateNow();
    const safeSeed = String(this.runSeed).replace(/[^a-zA-Z0-9_-]/g, '_');
    const base = `${this.currentMatchId}_seed-${safeSeed}_${ts}`;

    const emitted: string[] = [];
    const formatRows = (rows: any[]) => format === 'csv'
      ? this.formatTrainingEventsCSV(rows)
      : rows.map((event) => JSON.stringify(event)).join('\n');

    const fullName = `${base}_full.${ext}`;
    this.downloadTextAsFile(formatRows(snapshot), fullName, mimeType);
    emitted.push(fullName);

    if (split === 'rare-full') {
      const rareRows = snapshot.filter((event) => {
        if (typeof event?.rareScore === 'number' && event.rareScore > 0) {
          return true;
        }
        const tags = Array.isArray(event?.scenarioTags) ? event.scenarioTags : [];
        return tags.some((tag: string) => [
          'high_threat',
          'low_health',
          'opponent_low_health',
          'boss_present',
          'boss_on_my_side',
          'skill2_action',
          'skill3_action',
          'skill4_action',
        ].includes(tag));
      });

      const rareName = `${base}_rare.${ext}`;
      this.downloadTextAsFile(formatRows(rareRows), rareName, mimeType);
      emitted.push(rareName);
    }

    return emitted;
  }

  private downloadTextAsFile(content: string, filename: string, mimeType: string) {
    if (this.runtime.saveFile) {
      this.runtime.saveFile(content, filename, mimeType);
      return;
    }

    const blob = new Blob([content], { type: mimeType });
    const url = this.runtime.createObjectURL(blob);
    if (!url) {
      return;
    }

    const link = this.runtime.createElement('a') as HTMLAnchorElement | null;
    if (!link) {
      this.runtime.revokeObjectURL(url);
      return;
    }

    link.href = url;
    link.download = filename;
    link.click();
    this.runtime.revokeObjectURL(url);
  }

  destroy() {
    this.running = false;
    if (this.animationFrameId) {
      this.runtime.cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = 0;
    }
    for (const timeoutId of this.managedTimeoutIds) {
      this.runtime.clearTimeout(timeoutId);
    }
    this.managedTimeoutIds.clear();
    this.skillLifecycles.clear();
    this.activeSkillLifecycleBySide = { left: null, right: null };
    this.removeEventListeners();

    if (this.svgOverlay && this.svgOverlay.parentElement) {
      this.svgOverlay.parentElement.removeChild(this.svgOverlay);
      this.svgOverlay = null;
    }

    this.leftBackdropCache = null;
    this.rightBackdropCache = null;
    this.dividerCache = null;
  }

  isRunning(): boolean {
    return this.running;
  }

  runWithLifecycle(callback: () => void, delayMs: number): number {
    const timeoutId = this.runtime.setTimeout(() => {
      this.managedTimeoutIds.delete(timeoutId);
      if (!this.running) {
        return;
      }
      callback();
    }, delayMs);

    this.managedTimeoutIds.add(timeoutId);
    return timeoutId;
  }

  beginSkillLifecycle(side: PlayerSide): number {
    const id = this.nextSkillLifecycleId++;
    this.skillLifecycles.set(id, {
      id,
      side,
      activeEntities: 0,
      pendingCallbacks: 0,
    });
    this.activeSkillLifecycleBySide[side] = id;
    return id;
  }

  isSkillLifecycleActive(side: PlayerSide): boolean {
    const id = this.activeSkillLifecycleBySide[side];
    return id !== null && this.skillLifecycles.has(id);
  }

  scheduleSkillLifecycleCallback(tokenId: number, callback: () => void, delayMs: number): number {
    const lifecycle = this.skillLifecycles.get(tokenId);
    if (!lifecycle) {
      return this.runWithLifecycle(callback, delayMs);
    }

    lifecycle.pendingCallbacks += 1;
    return this.runWithLifecycle(() => {
      try {
        callback();
      } finally {
        lifecycle.pendingCallbacks = Math.max(0, lifecycle.pendingCallbacks - 1);
        this.tryCompleteSkillLifecycle(tokenId);
      }
    }, delayMs);
  }

  addSkillBullet(bullet: Bullet, tokenId: number) {
    bullet.attachSkillLifecycle(tokenId);
    this.registerSkillEntity(tokenId);
    this.addBullet(bullet);
  }

  attachSkillBoss(boss: Boss, tokenId: number) {
    boss.attachSkillLifecycle(tokenId);
    this.registerSkillEntity(tokenId);
  }

  attachSkillField(targetSide: PlayerSide, ownerSide: PlayerSide, radiusRatio: number, durationMs: number, tokenId: number) {
    this.triggerExpandingField(targetSide, ownerSide, radiusRatio, durationMs, tokenId);
  }

  completeSkillEntity(tokenId: number) {
    const lifecycle = this.skillLifecycles.get(tokenId);
    if (!lifecycle) {
      return;
    }

    lifecycle.activeEntities = Math.max(0, lifecycle.activeEntities - 1);
    this.tryCompleteSkillLifecycle(tokenId);
  }

  private registerSkillEntity(tokenId: number) {
    const lifecycle = this.skillLifecycles.get(tokenId);
    if (!lifecycle) {
      return;
    }

    lifecycle.activeEntities += 1;
  }

  private tryCompleteSkillLifecycle(tokenId: number) {
    const lifecycle = this.skillLifecycles.get(tokenId);
    if (!lifecycle) {
      return;
    }

    if (lifecycle.activeEntities > 0 || lifecycle.pendingCallbacks > 0) {
      return;
    }

    this.skillLifecycles.delete(tokenId);
    if (this.activeSkillLifecycleBySide[lifecycle.side] === tokenId) {
      this.activeSkillLifecycleBySide[lifecycle.side] = null;
    }
  }

  private getScoreSystem(side: PlayerSide): ScoreSystem {
    return side === 'left' ? this.scoreSystem1 : (this.scoreSystem2 ?? this.scoreSystem1);
  }

  private getComboSystem(side: PlayerSide): ComboSystem {
    return side === 'left' ? this.comboSystem1 : (this.comboSystem2 ?? this.comboSystem1);
  }

  private getChargeSystem(side: PlayerSide): ChargeSystem {
    return side === 'left' ? this.chargeSystem1 : (this.chargeSystem2 ?? this.chargeSystem1);
  }

  private getVisibleScore(side: PlayerSide): number {
    return this.getScoreSystem(side).getVisibleScore();
  }

  private getScoreTrendSides(): PlayerSide[] {
    if (this.gameMode === 'single') {
      return ['right'];
    }

    if (this.gameMode === 'selfplay') {
      return ['left', 'right'];
    }

    return [];
  }

  private resetScoreTrendTracking() {
    const nextState = {} as Record<PlayerSide, ScoreTrendState>;
    for (const side of ['left', 'right'] as const) {
      nextState[side] = {
        elapsedMs: 0,
        lastVisibleScore: this.getVisibleScore(side),
        cumulativePenalty: 0,
        penaltyEvents: 0,
      };
    }
    this.scoreTrendState = nextState;
  }

  private getScoreTrendTargetGain(side: PlayerSide): number {
    const visibleScore = this.getVisibleScore(side);
    const growthBonus = Math.floor(visibleScore / this.scoreTrendGrowthStep);
    const difficultyScale = this.aiDifficulty === 'hard' ? 1.15 : this.aiDifficulty === 'easy' ? 0.9 : 1;
    return Math.max(4, Math.min(
      this.scoreTrendMaxGain,
      Math.round((this.scoreTrendBaseGain + growthBonus) * difficultyScale),
    ));
  }

  private computeFinalScoreReward(side: PlayerSide): number {
    const visibleScore = this.getVisibleScore(side);
    return Math.min(this.finalScoreRewardCap, Math.round(visibleScore * this.finalScoreRewardScale));
  }

  private getScoreShapingSnapshot(side: PlayerSide) {
    const scoreSystem = this.getScoreSystem(side);
    const trend = this.scoreTrendState[side];
    const visibleScore = scoreSystem.getVisibleScore();
    const finalScoreReward = this.computeFinalScoreReward(side);

    return {
      totalScore: scoreSystem.getTotalScore(),
      comboScore: scoreSystem.getComboScore(),
      visibleScore,
      scoreTrendPenalty: trend.cumulativePenalty,
      scoreTrendPenaltyEvents: trend.penaltyEvents,
      finalScoreReward,
      finalScoreRewardTotal: trend.cumulativePenalty + finalScoreReward,
    };
  }

  private updateScoreTrendSignals(deltaTime: number) {
    for (const side of this.getScoreTrendSides()) {
      const trend = this.scoreTrendState[side];
      trend.elapsedMs += deltaTime;

      while (trend.elapsedMs >= this.scoreTrendWindowMs) {
        trend.elapsedMs -= this.scoreTrendWindowMs;

        const currentVisibleScore = this.getVisibleScore(side);
        const scoreGain = currentVisibleScore - trend.lastVisibleScore;
        const expectedGain = this.getScoreTrendTargetGain(side);

        if (scoreGain < expectedGain) {
          const shortfall = expectedGain - scoreGain;
          const penalty = -Math.max(1, Math.round(shortfall * this.scoreTrendPenaltyScale));
          trend.cumulativePenalty += penalty;
          trend.penaltyEvents += 1;

          this.pushTrainingEvent({
            game_event: 'score_trend',
            side,
            scoreWindowMs: this.scoreTrendWindowMs,
            scoreBefore: trend.lastVisibleScore,
            scoreAfter: currentVisibleScore,
            scoreDelta: scoreGain,
            expectedScoreDelta: expectedGain,
            reward: penalty,
            rewardReason: 'low_score_growth',
            scoreTotal: this.getScoreSystem(side).getTotalScore(),
            scoreCombo: this.getScoreSystem(side).getComboScore(),
            scoreVisible: currentVisibleScore,
            scoreTrendPenalty: penalty,
            scoreTrendCumulativePenalty: trend.cumulativePenalty,
          });
        }

        trend.lastVisibleScore = currentVisibleScore;
      }
    }
  }

  private bankComboScore(side: PlayerSide) {
    const scoreSystem = this.getScoreSystem(side);
    const bankedScore = scoreSystem.bankCombo();
    // ensure the combo system is reset after banking so the segment is cleared
    const comboSystem = this.getComboSystem(side);
    comboSystem.reset();

    // ensure the visible slot is cleared even if bankedScore is zero
    scoreSystem.clearComboSlot();

    if (bankedScore > 0) {
      this.resolveScoreThresholds(side);
    }
  }

  // Unified combo interruption handler: banks combo score, resets combo, and
  // exposes a single place to add visual/audio hooks in future.
  private interruptCombo(side: PlayerSide) {
    this.bankComboScore(side);
  }

  awardBulletClear(side: PlayerSide, count: number) {
    this.getScoreSystem(side).addBulletClear(count);
  }

  awardEnemyDefeat(side: PlayerSide, enemy: Enemy) {
    this.registerEnemyDefeat(side, enemy);
  }

  awardBossDefeat(side: PlayerSide) {
    this.onBossKilled(side);
  }

  private resolveScoreThresholds(side: PlayerSide) {
    const scoreSystem = this.getScoreSystem(side);
    while (scoreSystem.shouldTriggerBoss()) {
      this.triggerScoreBoss(side);
      scoreSystem.advanceBossThreshold();
    }
  }

  private triggerScoreBoss(side: PlayerSide) {
    const targetSide = side === 'left' ? 'right' : 'left';
    const currentBoss = this.boss;
    const aircraftType = this.getPlayer(side)?.getAircraftType() ?? 'scatter';

    if (!currentBoss) {
      this.spawnBoss(targetSide, aircraftType);
      return;
    }

    if (currentBoss.side === targetSide) {
      this.grantBomb(side);
      return;
    }

    if (currentBoss.side === side) {
      this.getScoreSystem(side).addReverse();
      this.removeBoss();
      this.spawnBoss(targetSide, aircraftType);
      return;
    }

    this.removeBoss();
    this.spawnBoss(targetSide, aircraftType);
  }

  private grantBomb(side: PlayerSide) {
    const player = this.getPlayer(side);
    if (player) {
      player.bombs += 1;
    }
  }

  private spawnBoss(side: PlayerSide, aircraftType: AircraftType = 'scatter', skillTokenId?: number, ownerSide?: PlayerSide) {
    const bossX = side === 'left'
      ? this.SCREEN_WIDTH * 0.25
      : this.SCREEN_WIDTH * 0.75;

    switch (aircraftType) {
      case 'scatter':
        this.boss = new ScatterBoss(bossX, 100, side);
        break;
      case 'laser':
        this.boss = new LaserBoss(bossX, 100, side);
        break;
      case 'tracking':
        this.boss = new TrackingBoss(bossX, 100, side);
        break;
      default:
        this.boss = new ScatterBoss(bossX, 100, side);
        break;
    }

    if (this.boss) {
      // record which player (if any) caused this boss to spawn
      if (typeof ownerSide !== 'undefined') {
        (this.boss as any).ownerSide = ownerSide ?? null;
      }
      if (typeof skillTokenId === 'number') {
        this.attachSkillBoss(this.boss, skillTokenId);
      }
    }
  }
  
  private gameLoop(currentTime: number) {
    if (!this.running) {
      return;
    }

    if (this.lastTime === 0) {
      this.lastTime = currentTime;
      this.animationFrameId = this.runtime.requestAnimationFrame((t) => this.gameLoop(t));
      return;
    }

    const rawDeltaTime = currentTime - this.lastTime;
    const deltaTime = Math.min(rawDeltaTime, 100);
    this.lastTime = currentTime;
    this.accumulator += deltaTime;
    
    while (this.accumulator >= this.fixedDeltaTime) {
      this.step(this.fixedDeltaTime);
      this.accumulator -= this.fixedDeltaTime;
    }
    
    if (!this.headless) this.render();
    
    this.animationFrameId = this.runtime.requestAnimationFrame((t) => this.gameLoop(t));
  }
  
  private update(deltaTime: number) {
    if (this.gameOver) {
      return;
    }

    this.simulationFrame += 1;

    if (this.comboSystem1.update(deltaTime)) {
      this.interruptCombo('left');
    }

    if (this.comboSystem2 && this.comboSystem2.update(deltaTime)) {
      this.interruptCombo('right');
    }

    this.player1.update(deltaTime, this);
    
    if (this.player2) {
      this.player2.update(deltaTime, this);
    }
    
    if (this.aiControllerLeft) {
      this.aiControllerLeft.update(deltaTime);
    }
    if (this.aiControllerRight) {
      this.aiControllerRight.update(deltaTime);
    }
    
    this.waveSystem.update(deltaTime);
    this.updateExpandingFields(deltaTime);
    
    for (let enemy of this.enemies) {
      enemy.update(deltaTime, this);
    }
    
    for (let bullet of this.bullets) {
      bullet.update(deltaTime);

      if (!bullet.active && typeof bullet.getSkillLifecycleId === 'function') {
        const tokenId = bullet.getSkillLifecycleId();
        if (tokenId !== null) {
          bullet.clearSkillLifecycleId();
          this.completeSkillEntity(tokenId);
        }
      }

      if (bullet.active && !bullet.isTransferringState() && this.shouldCullBullet(bullet)) {
        bullet.active = false;
      }
    }
    
    if (this.boss) {
      this.boss.update(deltaTime, this);
      if (!this.boss.active) {
        const tokenId = this.boss.getSkillLifecycleId();
        if (tokenId !== null) {
          this.boss.clearSkillLifecycleId();
          this.completeSkillEntity(tokenId);
        }
        this.boss = null;
      }
    }
    
    this.checkCollisions();

    for (const bullet of this.bullets) {
      if (!bullet.active && typeof bullet.getSkillLifecycleId === 'function') {
        const tokenId = bullet.getSkillLifecycleId();
        if (tokenId !== null) {
          bullet.clearSkillLifecycleId();
          this.completeSkillEntity(tokenId);
        }
      }
    }

    this.updateScoreTrendSignals(deltaTime);
    
    // combo systems updated earlier in the frame; avoid double-updating here.
    
    this.compactActiveEntities(this.bullets);
    this.compactActiveEntities(this.enemies);
    this.updateGameOverState();
  }
  
  private render() {
    this.ctx.clearRect(0, 0, this.SCREEN_WIDTH, this.SCREEN_HEIGHT);

    const leftEnemies: Enemy[] = [];
    const rightEnemies: Enemy[] = [];
    for (const enemy of this.enemies) {
      if (enemy.side === 'left') {
        leftEnemies.push(enemy);
      } else {
        rightEnemies.push(enemy);
      }
    }

    const leftBullets: Bullet[] = [];
    const rightBullets: Bullet[] = [];
    for (const bullet of this.bullets) {
      if (bullet.side === 'left') {
        leftBullets.push(bullet);
      } else {
        rightBullets.push(bullet);
      }
    }

    this.renderSideWorld('left', leftEnemies, leftBullets);
    this.renderSideWorld('right', rightEnemies, rightBullets);
    this.renderScreenDivider();
    
    this.renderUI();

    if (this.gameOver) {
      this.ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
      this.ctx.fillRect(0, 0, this.SCREEN_WIDTH, this.SCREEN_HEIGHT);
      this.ctx.fillStyle = '#ffffff';
      this.ctx.font = '36px Microsoft YaHei';
      this.ctx.textAlign = 'center';
      this.ctx.fillText(this.winnerText, this.SCREEN_WIDTH / 2, this.SCREEN_HEIGHT / 2);
    }
  }

  private renderSideWorld(side: PlayerSide, enemies: Enemy[], bullets: Bullet[]) {
    const viewport = this.getSideViewport(side);

    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.rect(viewport.x, viewport.y, viewport.width, viewport.height);
    this.ctx.clip();

    this.renderArenaBackdrop(side, viewport);

    const player = this.getPlayer(side);
    if (player) {
      player.render(this.ctx);
    }

    for (const enemy of enemies) {
      enemy.render(this.ctx);
    }

    this.renderExpandingFields(side);

    for (const bullet of bullets) {
      bullet.render(this.ctx);
    }

    if (this.boss && this.boss.side === side) {
      this.boss.render(this.ctx);
    }

    this.ctx.restore();
  }
  
  private renderScreenDivider() {
    this.ensureStaticRenderCache();

    const dividerX = this.SCREEN_WIDTH / 2;
    const marginWidth = this.SCREEN_WIDTH * this.MARGIN / 2;

    const stripX = dividerX - marginWidth;
    if (this.dividerCache) {
      this.ctx.drawImage(this.dividerCache, stripX, 0);
    }
  }
  
  private renderUI() {
    const panelMargin = 16;
    const panelY = 16;
    const panelGap = 12;
    const panelWidth = Math.min(280, Math.floor((this.SCREEN_WIDTH - panelMargin * 2 - panelGap) / 2));
    const panelHeight = 122;
    const leftPanel = { x: panelMargin, y: panelY, w: panelWidth, h: panelHeight };
    const rightPanel = { x: this.SCREEN_WIDTH - panelMargin - panelWidth, y: panelY, w: panelWidth, h: panelHeight };
    const leftViewport = this.getSideViewport('left');
    const rightViewport = this.getSideViewport('right');
    const compactHud = panelWidth < 220;
    const cardInnerPadding = compactHud ? 10 : 12;
    const cardGap = compactHud ? 6 : 8;
    const cardHeight = compactHud ? 24 : 28;
    const cardWidth = Math.floor((panelWidth - cardInnerPadding * 2 - cardGap) / 2);
    const firstRowY = panelY + 42;
    const secondRowY = firstRowY + cardHeight + (compactHud ? 6 : 8);
    const scoreLabel = compactHud ? '分' : '分数';
    const comboLabel = compactHud ? '连' : '连击';
    const healthLabel = compactHud ? '血' : '血量';
    const bombLabel = compactHud ? '弹' : '炸弹';
    const gaugeHorizontalInset = compactHud ? 8 : 10;
    const gaugeBottomInset = 12;
    const gaugeHeight = 16;
    const leftGaugeX = leftViewport.x + gaugeHorizontalInset;
    const rightGaugeX = rightViewport.x + gaugeHorizontalInset;
    const gaugeY = this.SCREEN_HEIGHT - gaugeHeight - gaugeBottomInset;
    const leftGaugeWidth = Math.max(64, leftViewport.width - gaugeHorizontalInset * 2);
    const rightGaugeWidth = Math.max(64, rightViewport.width - gaugeHorizontalInset * 2);

    this.drawHudPanel(leftPanel.x, leftPanel.y, leftPanel.w, leftPanel.h, 'P1 / LEFT', '#59f0ff');
    this.drawHudPanel(rightPanel.x, rightPanel.y, rightPanel.w, rightPanel.h, 'P2 / RIGHT', '#ff6f8e');

    this.renderHudMetricCard(
      leftPanel.x + cardInnerPadding,
      firstRowY,
      cardWidth,
      cardHeight,
      scoreLabel,
      this.formatTotalScoreDisplay('left'),
      '#59f0ff',
    );
    this.renderHudMetricCard(
      leftPanel.x + cardInnerPadding + cardWidth + cardGap,
      firstRowY,
      cardWidth,
      cardHeight,
      comboLabel,
      this.formatComboScoreDisplay('left'),
      '#59f0ff',
    );
    this.renderHudMetricCard(
      leftPanel.x + cardInnerPadding,
      secondRowY,
      cardWidth,
      cardHeight,
      healthLabel,
      String(this.player1.health),
      '#59f0ff',
    );
    this.renderHudMetricCard(
      leftPanel.x + cardInnerPadding + cardWidth + cardGap,
      secondRowY,
      cardWidth,
      cardHeight,
      bombLabel,
      String(this.player1.bombs),
      '#59f0ff',
    );

    this.renderChargeBar(this.ctx, leftGaugeX, gaugeY, leftGaugeWidth, gaugeHeight, this.chargeSystem1, this.player1.getSide());
    
    if (this.player2 && this.chargeSystem2 && this.comboSystem2) {
      this.renderHudMetricCard(
        rightPanel.x + cardInnerPadding,
        firstRowY,
        cardWidth,
        cardHeight,
        scoreLabel,
        this.formatTotalScoreDisplay('right'),
        '#ff6f8e',
      );
      this.renderHudMetricCard(
        rightPanel.x + cardInnerPadding + cardWidth + cardGap,
        firstRowY,
        cardWidth,
        cardHeight,
        comboLabel,
        this.formatComboScoreDisplay('right'),
        '#ff6f8e',
      );
      this.renderHudMetricCard(
        rightPanel.x + cardInnerPadding,
        secondRowY,
        cardWidth,
        cardHeight,
        healthLabel,
        String(this.player2.health),
        '#ff6f8e',
      );
      this.renderHudMetricCard(
        rightPanel.x + cardInnerPadding + cardWidth + cardGap,
        secondRowY,
        cardWidth,
        cardHeight,
        bombLabel,
        String(this.player2.bombs),
        '#ff6f8e',
      );
      
      this.renderChargeBar(
        this.ctx, 
        rightGaugeX, 
        gaugeY,
        rightGaugeWidth,
        gaugeHeight,
        this.chargeSystem2, 
        this.player2.getSide()
      );

      if (this.aiControllerRight) {
        const chargeIntent = this.aiControllerRight.getChargeIntent();
        this.ctx.textAlign = 'left';
        this.ctx.fillStyle = chargeIntent.isCharging ? '#ffd166' : '#9eb2d7';
        this.ctx.font = compactHud ? '10px Microsoft YaHei' : '12px Microsoft YaHei';
        if (chargeIntent.isCharging) {
          const percent = Math.round(chargeIntent.progress * 100);
          this.ctx.fillText(`AI${compactHud ? ':' : '蓄力:'} ${chargeIntent.skill} ${percent}%`, rightPanel.x + cardInnerPadding, rightPanel.y + rightPanel.h + 18);
        } else {
          this.ctx.fillText(`AI${compactHud ? ':' : '蓄力:'} idle`, rightPanel.x + cardInnerPadding, rightPanel.y + rightPanel.h + 18);
        }
      }

      if (this.aiControllerLeft && this.gameMode === 'selfplay') {
        const chargeIntent = this.aiControllerLeft.getChargeIntent();
        this.ctx.textAlign = 'left';
        this.ctx.fillStyle = chargeIntent.isCharging ? '#ffd166' : '#9eb2d7';
        this.ctx.font = compactHud ? '10px Microsoft YaHei' : '12px Microsoft YaHei';
        if (chargeIntent.isCharging) {
          const percent = Math.round(chargeIntent.progress * 100);
          this.ctx.fillText(`AI${compactHud ? ':' : '蓄力:'} ${chargeIntent.skill} ${percent}%`, leftPanel.x + cardInnerPadding, leftPanel.y + leftPanel.h + 18);
        } else {
          this.ctx.fillText(`AI${compactHud ? ':' : '蓄力:'} idle`, leftPanel.x + cardInnerPadding, leftPanel.y + leftPanel.h + 18);
        }
      }
    }
  }

  private renderHudMetricCard(x: number, y: number, width: number, height: number, label: string, value: string, accent: string) {
    const compact = width < 100 || height < 26;

    this.ctx.save();
    this.drawRoundedRect(this.ctx, x, y, width, height, Math.max(8, Math.min(12, height / 2)));
    const background = this.ctx.createLinearGradient(x, y, x, y + height);
    background.addColorStop(0, 'rgba(255, 255, 255, 0.07)');
    background.addColorStop(1, 'rgba(255, 255, 255, 0.03)');
    this.ctx.fillStyle = background;
    this.ctx.fill();
    this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    this.ctx.stroke();

    this.ctx.fillStyle = accent;
    this.ctx.fillRect(x + 1, y + 1, Math.max(2, Math.min(width - 2, Math.round(width * 0.18))), 2);

    this.ctx.textAlign = 'left';
    this.ctx.fillStyle = 'rgba(255, 255, 255, 0.72)';
    this.ctx.font = `${compact ? 9 : 10}px Microsoft YaHei`;
    this.ctx.fillText(label, x + 8, y + (compact ? 11 : 12));

    this.ctx.textAlign = 'right';
    this.ctx.fillStyle = '#eef4ff';
    this.ctx.font = `700 ${compact ? 11 : 13}px Microsoft YaHei`;
    this.ctx.fillText(value, x + width - 8, y + height - (compact ? 5 : 7));

    this.ctx.restore();
  }

  private formatTotalScoreDisplay(side: PlayerSide): string {
    const scoreSystem = this.getScoreSystem(side);
    return this.formatHudNumber(scoreSystem.getTotalScore());
  }

  private formatComboScoreDisplay(side: PlayerSide): string {
    const scoreSystem = this.getScoreSystem(side);
    const comboScore = scoreSystem.getComboScore();

    if (comboScore <= 0) {
      return '0';
    }

    return `+${this.formatHudNumber(comboScore)}`;
  }

  private formatHudNumber(value: number): string {
    const safeValue = Math.trunc(value);
    const absValue = Math.abs(safeValue);

    if (absValue < 10_000) {
      return String(safeValue);
    }

    if (absValue < 1_000_000) {
      const scaled = safeValue / 1_000;
      return `${scaled >= 100 ? scaled.toFixed(0) : scaled.toFixed(1)}k`;
    }

    const scaled = safeValue / 1_000_000;
    return `${scaled >= 100 ? scaled.toFixed(0) : scaled.toFixed(1)}M`;
  }
  
  private renderChargeBar(
    ctx: CanvasRenderingContext2D, 
    x: number, 
    y: number, 
    width: number, 
    height: number,
    chargeSystem: ChargeSystem,
    _side: PlayerSide
  ) {
    const chargeMax = chargeSystem.getChargeMax();
    const currentCharge = chargeSystem.getCurrentCharge();
    const maxCharge = chargeSystem.getMaxChargeCap();
    const thresholds = chargeSystem.getThresholds();

    // Determine display color based on accumulated gauge thresholds
    let activeColor = '#9eb2d7';
    if (chargeMax >= maxCharge) activeColor = '#fff176';
    else if (chargeMax >= thresholds.level3) activeColor = '#ff6f8e';
    else if (chargeMax >= thresholds.level2) activeColor = '#ffd166';
    else if (chargeMax >= thresholds.level1) activeColor = '#59f0ff';

    ctx.save();
    this.drawRoundedRect(ctx, x, y, width, height, height / 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.stroke();

    // accumulated gauge (reserve) overlay
    const accumulatedWidth = Math.max(0, Math.min(width, (chargeMax / maxCharge) * width));
    this.drawRoundedRect(ctx, x, y, accumulatedWidth, height, height / 2);
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fill();

    // hold-charge filled portion
    const safeCurrent = Math.min(currentCharge, chargeMax);
    const filledWidth = Math.max(0, Math.min(width, (safeCurrent / maxCharge) * width));

    const fillGradient = ctx.createLinearGradient(x, y, x + width, y);
    fillGradient.addColorStop(0, activeColor);
    fillGradient.addColorStop(1, 'rgba(255,255,255,0.12)');

    this.drawRoundedRect(ctx, x, y, filledWidth, height, height / 2);
    ctx.fillStyle = fillGradient;
    ctx.fill();

    // small sheen + glow
    ctx.shadowColor = activeColor;
    ctx.shadowBlur = 10;
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(x, y, Math.min(18, filledWidth), height);
    ctx.shadowBlur = 0;

    // colored threshold ticks
    const tickColor1 = '#59f0ff';
    const tickColor2 = '#ffd166';
    const tickColor3 = '#ff6f8e';
    const thresholdX1 = x + (thresholds.level1 / maxCharge) * width;
    const thresholdX2 = x + (thresholds.level2 / maxCharge) * width;
    const thresholdX3 = x + (thresholds.level3 / maxCharge) * width;

    ctx.lineWidth = 1.5;
    ([[thresholdX1, tickColor1], [thresholdX2, tickColor2], [thresholdX3, tickColor3]] as [number, string][]).forEach(([tx, color]: [number, string]) => {
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(tx, y - 2);
      ctx.lineTo(tx, y + height + 2);
      ctx.stroke();
    });

    // subtle baseline
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y + height / 2);
    ctx.lineTo(x + width, y + height / 2);
    ctx.stroke();

    // special pulsing effect when final threshold reached (either reserve cap or held to cap)
    const reachedFinal = chargeMax >= maxCharge || safeCurrent >= maxCharge;
    if (reachedFinal && filledWidth > 0) {
      const now = this.runtime.now();
      const pulse = 0.5 + 0.5 * Math.sin(now / 240);
      ctx.save();
      ctx.globalAlpha = 0.12 + 0.06 * pulse;
      ctx.shadowColor = activeColor;
      ctx.shadowBlur = 20 * (1 + pulse);
      this.drawRoundedRect(ctx, x - 2, y - 2, filledWidth + 4, height + 4, (height + 4) / 2);
      ctx.fillStyle = activeColor;
      ctx.fill();
      ctx.restore();

      // moving sheen over filled area
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const sheenW = Math.max(16, width * 0.12);
      const sheenX = x + ((now % 1200) / 1200) * (Math.max(0, filledWidth + sheenW)) - sheenW;
      const sheenGrad = ctx.createLinearGradient(sheenX, y, sheenX + sheenW, y);
      sheenGrad.addColorStop(0, 'rgba(255,255,255,0)');
      sheenGrad.addColorStop(0.5, 'rgba(255,255,255,0.45)');
      sheenGrad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = sheenGrad;
      this.drawRoundedRect(ctx, sheenX, y, sheenW, height, height / 2);
      ctx.fill();
      ctx.restore();
    }

    ctx.fillStyle = '#dbe7ff';
    ctx.font = '10px Microsoft YaHei';
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.round(chargeMax)}/${maxCharge}`, x + width - 4, y - 4);
    ctx.restore();
  }

  private drawHudPanel(x: number, y: number, width: number, height: number, title: string, accent: string) {
    this.ctx.save();
    this.drawRoundedRect(this.ctx, x, y, width, height, 18);
    const panelGradient = this.ctx.createLinearGradient(x, y, x, y + height);
    panelGradient.addColorStop(0, 'rgba(13, 22, 42, 0.82)');
    panelGradient.addColorStop(1, 'rgba(7, 12, 26, 0.9)');
    this.ctx.fillStyle = panelGradient;
    this.ctx.fill();
    this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    this.ctx.stroke();

    this.ctx.fillStyle = accent;
    this.ctx.fillRect(x + 14, y + 14, Math.min(54, Math.max(28, width - 28)), 3);
    this.ctx.fillStyle = 'rgba(255, 255, 255, 0.88)';
    this.ctx.font = `700 ${width < 180 ? 10 : 12}px Microsoft YaHei`;
    this.ctx.textAlign = 'left';
    this.ctx.fillText(title, x + 14, y + 34);
    this.ctx.restore();
  }

  private renderArenaBackdrop(side: PlayerSide, viewport: { x: number; y: number; width: number; height: number }) {
    this.ensureStaticRenderCache();
    const cache = side === 'left' ? this.leftBackdropCache : this.rightBackdropCache;
    const accent = side === 'left' ? 'rgba(89, 240, 255, 0.15)' : 'rgba(255, 111, 142, 0.15)';
    if (cache) {
      this.ctx.drawImage(cache, viewport.x, viewport.y);
    }

    const scanPhase = (this.runtime.now() * 0.02) % viewport.height;
    const scanY = viewport.y + scanPhase;
    const scanGradient = this.ctx.createLinearGradient(viewport.x, scanY - 24, viewport.x, scanY + 24);
    scanGradient.addColorStop(0, 'transparent');
    scanGradient.addColorStop(0.5, accent);
    scanGradient.addColorStop(1, 'transparent');
    this.ctx.fillStyle = scanGradient;
    this.ctx.fillRect(viewport.x, scanY - 18, viewport.width, 36);
    this.ctx.restore();
  }

  private ensureStaticRenderCache() {
    if (this.leftBackdropCache && this.rightBackdropCache && this.dividerCache) {
      return;
    }

    const leftViewport = this.getSideViewport('left');
    const rightViewport = this.getSideViewport('right');
    this.leftBackdropCache = this.buildSideBackdropLayer('left', leftViewport.width, leftViewport.height);
    this.rightBackdropCache = this.buildSideBackdropLayer('right', rightViewport.width, rightViewport.height);

    const stripWidth = this.SCREEN_WIDTH * this.MARGIN;
    this.dividerCache = this.buildDividerLayer(stripWidth, this.SCREEN_HEIGHT);
  }

  private buildSideBackdropLayer(side: PlayerSide, width: number, height: number): HTMLCanvasElement {
    const canvas = this.runtime.createElement('canvas') as HTMLCanvasElement | null;
    if (!canvas) {
      return this.ctx.canvas;
    }
    canvas.width = Math.max(1, Math.ceil(width));
    canvas.height = Math.max(1, Math.ceil(height));
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return canvas;
    }

    const accent = side === 'left' ? 'rgba(89, 240, 255, 0.15)' : 'rgba(255, 111, 142, 0.15)';
    const borderColor = side === 'left' ? 'rgba(89, 240, 255, 0.18)' : 'rgba(255, 111, 142, 0.18)';

    const baseGradient = ctx.createLinearGradient(0, 0, 0, height);
    baseGradient.addColorStop(0, 'rgba(9, 15, 31, 0.88)');
    baseGradient.addColorStop(1, 'rgba(5, 8, 18, 0.96)');
    ctx.fillStyle = baseGradient;
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.globalAlpha = 0.12;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1;
    const gridStep = 36;
    for (let gx = 0; gx <= width; gx += gridStep) {
      ctx.beginPath();
      ctx.moveTo(gx, 0);
      ctx.lineTo(gx, height);
      ctx.stroke();
    }
    for (let gy = 0; gy <= height; gy += gridStep) {
      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.lineTo(width, gy);
      ctx.stroke();
    }
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, Math.max(1, width - 2), Math.max(1, height - 2));
    ctx.restore();

    return canvas;
  }

  private buildDividerLayer(width: number, height: number): HTMLCanvasElement {
    const canvas = this.runtime.createElement('canvas') as HTMLCanvasElement | null;
    if (!canvas) {
      return this.ctx.canvas;
    }
    const safeWidth = Math.max(1, Math.ceil(width));
    const safeHeight = Math.max(1, Math.ceil(height));
    canvas.width = safeWidth;
    canvas.height = safeHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return canvas;
    }

    const centerX = safeWidth / 2;
    const dividerGradient = ctx.createLinearGradient(0, 0, safeWidth, 0);
    dividerGradient.addColorStop(0, 'rgba(89, 240, 255, 0.02)');
    dividerGradient.addColorStop(0.5, 'rgba(234, 69, 96, 0.16)');
    dividerGradient.addColorStop(1, 'rgba(255, 209, 102, 0.04)');
    ctx.fillStyle = dividerGradient;
    ctx.fillRect(0, 0, safeWidth, safeHeight);

    ctx.save();
    ctx.shadowColor = 'rgba(234, 69, 96, 0.45)';
    ctx.shadowBlur = 18;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.82)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(centerX, 0);
    ctx.lineTo(centerX, safeHeight);
    ctx.stroke();
    ctx.restore();

    ctx.strokeStyle = 'rgba(89, 240, 255, 0.22)';
    ctx.lineWidth = 1;
    for (let y = 10; y < safeHeight; y += 36) {
      ctx.beginPath();
      ctx.moveTo(centerX - 10, y);
      ctx.lineTo(centerX + 10, y + 8);
      ctx.stroke();
    }

    return canvas;
  }

  private drawRoundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
    const r = Math.max(0, Math.min(radius, Math.min(width, height) / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  private updateExpandingFields(deltaTime: number) {
    if (this.expandingFields.length === 0) {
      return;
    }

    const leftBullets: Bullet[] = [];
    const rightBullets: Bullet[] = [];
    for (const bullet of this.bullets) {
      if (!bullet.active) {
        continue;
      }
      if (bullet.side === 'left') {
        leftBullets.push(bullet);
      } else {
        rightBullets.push(bullet);
      }
    }

    const leftEnemies: Enemy[] = [];
    const rightEnemies: Enemy[] = [];
    for (const enemy of this.enemies) {
      if (!enemy.active) {
        continue;
      }
      if (enemy.side === 'left') {
        leftEnemies.push(enemy);
      } else {
        rightEnemies.push(enemy);
      }
    }

    for (const field of this.expandingFields) {
      field.elapsed = Math.min(field.duration, field.elapsed + deltaTime);
      const progress = field.duration <= 0 ? 1 : field.elapsed / field.duration;
      const radius = field.targetRadius * progress;
      const radiusSq = radius * radius;
      let clearedBullets = 0;
      const fieldBullets = field.side === 'left' ? leftBullets : rightBullets;
      const fieldEnemies = field.side === 'left' ? leftEnemies : rightEnemies;

      for (const bullet of fieldBullets) {
        if (!bullet.active) {
          continue;
        }

        const ownCategory = field.ownerSide === 'left' ? 'player1' : 'player2';
        if (bullet.category === ownCategory) {
          continue;
        }

        const bx = bullet.x + bullet.width / 2;
        const by = bullet.y + bullet.height / 2;
        const dx = bx - field.x;
        const dy = by - field.y;
        if (dx * dx + dy * dy <= radiusSq) {
          // Only clear bullets that are allowed to be destroyed by fields
          if ((bullet as any).canBeDestroyed) {
            bullet.active = false;
            clearedBullets += 1;
          }
        }
      }

      if (clearedBullets > 0) {
        this.getScoreSystem(field.ownerSide).addBulletClear(clearedBullets);
      }

      for (const enemy of fieldEnemies) {
        if (!enemy.active) {
          continue;
        }

        const ex = enemy.x + enemy.width / 2;
        const ey = enemy.y + enemy.height / 2;
        const dx = ex - field.x;
        const dy = ey - field.y;
        if (dx * dx + dy * dy <= radiusSq) {
          enemy.active = false;
          // Use onEnemyKilled to ensure the full explosion chain runs
          // (registerEnemyDefeat only updates score/charge but does not
          // trigger the explosion that can transfer bullets).
          this.onEnemyKilled(enemy, field.ownerSide);
        }
      }
    }

    let write = 0;
    for (let i = 0; i < this.expandingFields.length; i++) {
      const field = this.expandingFields[i];
      if (field.elapsed >= field.duration) {
        if (typeof field.skillTokenId === 'number') {
          this.completeSkillEntity(field.skillTokenId);
        }
        continue;
      }
      this.expandingFields[write++] = field;
    }
    this.expandingFields.length = write;
  }

  private renderExpandingFields(side: PlayerSide) {
    for (const field of this.expandingFields) {
      if (field.side !== side) {
        continue;
      }

      const progress = field.duration <= 0 ? 1 : field.elapsed / field.duration;
      const radius = field.targetRadius * progress;
      const alpha = 0.18 * (1 - progress * 0.35);
      const stroke = side === 'left' ? 'rgba(89, 240, 255, 0.62)' : 'rgba(255, 111, 142, 0.62)';

      this.ctx.save();
      this.ctx.beginPath();
      this.ctx.arc(field.x, field.y, radius, 0, Math.PI * 2);
      this.ctx.fillStyle = side === 'left'
        ? `rgba(89, 240, 255, ${alpha})`
        : `rgba(255, 111, 142, ${alpha})`;
      this.ctx.fill();
      this.ctx.strokeStyle = stroke;
      this.ctx.lineWidth = 2;
      this.ctx.stroke();
      this.ctx.restore();
    }
  }

  triggerExpandingField(targetSide: PlayerSide, ownerSide: PlayerSide, radiusRatio: number, durationMs = 1000, skillTokenId?: number) {
    const viewport = this.getSideViewport(targetSide);
    const targetPlayer = this.getPlayer(targetSide);
    const centerX = targetPlayer ? targetPlayer.x + targetPlayer.width / 2 : viewport.x + viewport.width / 2;
    const centerY = targetPlayer ? targetPlayer.y + targetPlayer.height / 2 : viewport.y + viewport.height / 2;
    const clampedRatio = Math.max(0, radiusRatio);
    const targetRadius = Math.max(1, viewport.width * clampedRatio);

    this.expandingFields.push({
      side: targetSide,
      ownerSide,
      x: centerX,
      y: centerY,
      elapsed: 0,
      duration: Math.max(1, durationMs),
      targetRadius,
      skillTokenId,
    });

    if (typeof skillTokenId === 'number') {
      this.registerSkillEntity(skillTokenId);
    }
  }
  
  private checkCollisions() {
    const enemyCollisionDamage = 15;
    const leftActiveEnemies: Enemy[] = [];
    const rightActiveEnemies: Enemy[] = [];

    for (const enemy of this.enemies) {
      if (!enemy.active) {
        continue;
      }

      if (enemy.side === 'left') {
        leftActiveEnemies.push(enemy);
      } else {
        rightActiveEnemies.push(enemy);
      }
    }

    for (let bullet of this.bullets) {
      if (!bullet.active) continue;

      // ===== 玩家子弹 (player1/player2)：只伤害敌机/Boss =====
      if (bullet.category === 'player1' || bullet.category === 'player2') {
        // player1 命中左侧战区敌机，player2 命中右侧战区敌机
        const targetSide = bullet.category === 'player1' ? 'left' : 'right';

        // 检测与敌机碰撞
        const targetEnemies = targetSide === 'left' ? leftActiveEnemies : rightActiveEnemies;
        for (const enemy of targetEnemies) {
          if (!enemy.active) {
            continue;
          }

          if (!this.isCollidingWithEnemyShape(bullet, enemy)) {
            continue;
          }

          if (bullet.bulletType === 'special' && bullet.hasHit(enemy)) {
            continue;
          }

          bullet.markHit(enemy);
          enemy.health -= bullet.damage;
          enemy.health = Math.max(0, normalizeHealth(enemy.health));

          // 特殊子弹不消失，普通子弹消失
          if (bullet.bulletType === 'normal') {
            bullet.active = false;
          }

          if (enemy.health <= 0) {
            enemy.health = 0;
            enemy.active = false;
            this.onEnemyKilled(enemy, targetSide);
          }

          if (bullet.bulletType === 'normal') {
            break;
          }
        }

        // 检测与Boss碰撞
        if (bullet.active && this.boss && this.boss.side === targetSide) {
          if (this.isColliding(bullet, this.boss)) {
                if (!this.boss.canTakeDamage()) {
                  continue;
                }
                if (bullet.bulletType === 'special' && bullet.hasHit(this.boss)) {
                  continue;
                }
                // logging disabled: boss hit attempt

                bullet.markHit(this.boss);
                this.boss.health -= bullet.damage;
                this.boss.health = Math.max(0, normalizeHealth(this.boss.health));

                // logging disabled: boss health changed

                if (bullet.bulletType === 'normal') {
                  bullet.active = false;
                }

                if (this.boss.health <= 0) {
                  const bossSide = this.boss.side;
                  // logging disabled: boss killed
                  this.removeBoss();
                  this.onBossKilled(bossSide);
                }
          }
        }
        continue;  // 玩家子弹不检测与玩家碰撞，不消除任何子弹
      }

      // ===== 弹幕 (barrage)：只伤害玩家 =====
      if (bullet.category === 'barrage') {
        const targetPlayer = bullet.side === 'left' ? this.player1 : this.player2;

        if (targetPlayer && ((bullet as { isBossLaser?: boolean }).isBossLaser ? this.isCollidingWithBossLaser(bullet, targetPlayer) : this.isCollidingWithPlayerHitbox(bullet, targetPlayer))) {
            const isPersistentBeam = typeof bullet.isBeamLike === 'function' && bullet.isBeamLike();
            const isIndestructible = bullet.canBeDestroyed === false;
            let tookDamage = false;

            if (isPersistentBeam || isIndestructible) {
              if (!bullet.hasHit(targetPlayer)) {
                bullet.markHit(targetPlayer);
                tookDamage = targetPlayer.applyDamage(bullet.damage, this);
              }
            } else {
              tookDamage = targetPlayer.applyDamage(bullet.damage, this);
              bullet.active = false;
            }

            // 被弹幕命中时清空该侧连击
            if (tookDamage) {
              const side = targetPlayer.getSide();
              if (side === 'left') {
                this.interruptCombo('left');
              } else if (this.comboSystem2) {
                this.interruptCombo('right');
              }
            }
        }
      }
    }

    // ===== 玩家与杂兵接触碰撞：玩家扣血，杂兵消失 =====
    for (const enemy of leftActiveEnemies) {
      if (!enemy.active) continue;

      const targetPlayer = this.player1;
      if (!targetPlayer) continue;

      if (this.isCollidingEnemyWithPlayerShape(enemy, targetPlayer)) {
        const tookDamage = targetPlayer.applyDamage(enemyCollisionDamage, this);
        enemy.active = false;

        // 接触受伤同样会清空该侧连击
        if (tookDamage) {
          const side = targetPlayer.getSide();
          if (side === 'left') {
            this.interruptCombo('left');
          } else {
            if (this.comboSystem2) {
              this.interruptCombo('right');
            }
          }
        }
      }
    }

    for (const enemy of rightActiveEnemies) {
      if (!enemy.active) continue;

      const targetPlayer = this.player2;
      if (!targetPlayer) continue;

      if (this.isCollidingEnemyWithPlayerShape(enemy, targetPlayer)) {
        const tookDamage = targetPlayer.applyDamage(enemyCollisionDamage, this);
        enemy.active = false;

        if (tookDamage && this.comboSystem2) {
          this.interruptCombo('right');
        }
      }
    }

    // 注意：玩家子弹不能消除弹幕！消弹只能通过小怪爆炸！
  }
  
  private isColliding(a: { x: number; y: number; width: number; height: number }, 
                      b: { x: number; y: number; width: number; height: number }): boolean {
    return a.x < b.x + b.width &&
           a.x + a.width > b.x &&
           a.y < b.y + b.height &&
           a.y + a.height > b.y;
  }

  private isCollidingWithEnemyShape(
    rect: { x: number; y: number; width: number; height: number },
    enemy: Enemy
  ): boolean {
    return this.isRectCollidingWithPolygon(rect, enemy.getCollisionPolygon());
  }

  private isCollidingWithPlayerHitbox(
    a: { x: number; y: number; width: number; height: number },
    player: Player
  ): boolean {
    const hitbox = player.getHitbox();
    const nearestX = Math.max(a.x, Math.min(hitbox.x, a.x + a.width));
    const nearestY = Math.max(a.y, Math.min(hitbox.y, a.y + a.height));
    const dx = hitbox.x - nearestX;
    const dy = hitbox.y - nearestY;
    return dx * dx + dy * dy <= hitbox.radius * hitbox.radius;
  }

  private isCollidingWithBossLaser(
    bullet: Bullet,
    player: Player
  ): boolean {
    const laser = typeof bullet.getSegmentLaserCollisionData === 'function'
      ? bullet.getSegmentLaserCollisionData()
      : null;

    if (!laser) {
      return this.isCollidingWithPlayerHitbox(bullet, player);
    }

    const hitbox = player.getHitbox();
    const nearest = this.closestPointOnSegment(
      hitbox.x,
      hitbox.y,
      laser.headX,
      laser.headY,
      laser.tailX,
      laser.tailY,
    );
    const dx = hitbox.x - nearest.x;
    const dy = hitbox.y - nearest.y;
    const effectiveRadius = hitbox.radius + laser.thicknessPx / 2;
    return dx * dx + dy * dy <= effectiveRadius * effectiveRadius;
  }

  private isCollidingEnemyWithPlayerShape(enemy: Enemy, player: Player): boolean {
    const hitbox = player.getHitbox();
    return this.isCircleCollidingWithPolygon(hitbox, enemy.getCollisionPolygon());
  }

  private isRectCollidingWithPolygon(
    rect: { x: number; y: number; width: number; height: number },
    polygon: Array<{ x: number; y: number }>
  ): boolean {
    const rectPoints = [
      { x: rect.x, y: rect.y },
      { x: rect.x + rect.width, y: rect.y },
      { x: rect.x + rect.width, y: rect.y + rect.height },
      { x: rect.x, y: rect.y + rect.height },
    ];

    for (const point of rectPoints) {
      if (this.isPointInPolygon(point, polygon)) {
        return true;
      }
    }

    for (const point of polygon) {
      if (
        point.x >= rect.x &&
        point.x <= rect.x + rect.width &&
        point.y >= rect.y &&
        point.y <= rect.y + rect.height
      ) {
        return true;
      }
    }

    for (let i = 0; i < rectPoints.length; i++) {
      const rectStart = rectPoints[i];
      const rectEnd = rectPoints[(i + 1) % rectPoints.length];
      for (let j = 0; j < polygon.length; j++) {
        const polyStart = polygon[j];
        const polyEnd = polygon[(j + 1) % polygon.length];
        if (this.doLineSegmentsIntersect(rectStart, rectEnd, polyStart, polyEnd)) {
          return true;
        }
      }
    }

    return false;
  }

  private isCircleCollidingWithPolygon(
    circle: { x: number; y: number; radius: number },
    polygon: Array<{ x: number; y: number }>
  ): boolean {
    if (this.isPointInPolygon({ x: circle.x, y: circle.y }, polygon)) {
      return true;
    }

    const radiusSq = circle.radius * circle.radius;
    for (let i = 0; i < polygon.length; i++) {
      const start = polygon[i];
      const end = polygon[(i + 1) % polygon.length];
      const nearest = this.closestPointOnSegment(circle.x, circle.y, start.x, start.y, end.x, end.y);
      const dx = circle.x - nearest.x;
      const dy = circle.y - nearest.y;
      if (dx * dx + dy * dy <= radiusSq) {
        return true;
      }
    }

    return false;
  }

  private isPointInPolygon(point: { x: number; y: number }, polygon: Array<{ x: number; y: number }>): boolean {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i].x;
      const yi = polygon[i].y;
      const xj = polygon[j].x;
      const yj = polygon[j].y;
      const intersects = ((yi > point.y) !== (yj > point.y)) &&
        (point.x < ((xj - xi) * (point.y - yi)) / ((yj - yi) || 1e-9) + xi);
      if (intersects) {
        inside = !inside;
      }
    }
    return inside;
  }

  private doLineSegmentsIntersect(
    a1: { x: number; y: number },
    a2: { x: number; y: number },
    b1: { x: number; y: number },
    b2: { x: number; y: number }
  ): boolean {
    const orientation = (p: { x: number; y: number }, q: { x: number; y: number }, r: { x: number; y: number }) => {
      const value = (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
      if (Math.abs(value) < 1e-9) {
        return 0;
      }
      return value > 0 ? 1 : 2;
    };

    const onSegment = (p: { x: number; y: number }, q: { x: number; y: number }, r: { x: number; y: number }) => {
      return q.x <= Math.max(p.x, r.x) + 1e-9 && q.x + 1e-9 >= Math.min(p.x, r.x) &&
             q.y <= Math.max(p.y, r.y) + 1e-9 && q.y + 1e-9 >= Math.min(p.y, r.y);
    };

    const o1 = orientation(a1, a2, b1);
    const o2 = orientation(a1, a2, b2);
    const o3 = orientation(b1, b2, a1);
    const o4 = orientation(b1, b2, a2);

    if (o1 !== o2 && o3 !== o4) {
      return true;
    }

    if (o1 === 0 && onSegment(a1, b1, a2)) return true;
    if (o2 === 0 && onSegment(a1, b2, a2)) return true;
    if (o3 === 0 && onSegment(b1, a1, b2)) return true;
    if (o4 === 0 && onSegment(b1, a2, b2)) return true;

    return false;
  }

  private closestPointOnSegment(
    px: number,
    py: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number
  ): { x: number; y: number } {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lengthSq = dx * dx + dy * dy;

    if (lengthSq <= 1e-9) {
      return { x: x1, y: y1 };
    }

    const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSq));
    return {
      x: x1 + dx * t,
      y: y1 + dy * t,
    };
  }

  private onEnemyKilled(enemy: Enemy, side: PlayerSide) {
    this.registerEnemyDefeat(side, enemy);
    
    this.triggerExplosion(enemy, side);
  }

  private registerEnemyDefeat(side: PlayerSide, enemy: Enemy) {
    const comboSystem = this.getComboSystem(side);
    const scoreSystem = this.getScoreSystem(side);
    const chargeSystem = this.getChargeSystem(side);

    comboSystem.increment();
    scoreSystem.addEnemyKill(enemy.maxHealth);

    // 每个击杀基础增量为 1，根据当前连击应用倍率（>20 -> x2, >10 -> x1.5）
    const combo = comboSystem.getCombo();
    const mult = combo > 20 ? 2 : combo > 10 ? 1.5 : 1;
    chargeSystem.addCharge(1 * mult);
  }
  
  private triggerExplosion(enemy: Enemy, side: PlayerSide) {
    const centerX = enemy.x + enemy.width / 2;
    const centerY = enemy.y + enemy.height / 2;
    const destroyRadius = Math.max(enemy.width, enemy.height) + 4;

    // 找出范围内可被消除的弹幕，范围随小怪尺寸同步放大
    const destroyableNearby = this.bullets.filter(b => {
      // only consider active, non-transferring barrage bullets that can be destroyed
      if (!b.active) return false;
      if (typeof (b as any).isTransferringState === 'function' && (b as any).isTransferringState()) return false;
      // do not consider beam-like lasers for transfer (they should be cleared, not transferred)
      if (typeof (b as any).isBeamLike === 'function' && (b as any).isBeamLike()) return false;
      const bulletCenterX = b.x + b.width / 2;
      const bulletCenterY = b.y + b.height / 2;
      const dist = Math.hypot(bulletCenterX - centerX, bulletCenterY - centerY);
      return dist < destroyRadius && b.category === 'barrage' && b.canBeDestroyed;
    });

    destroyableNearby.forEach(b => {
      b.active = false;
    });

    const transferableNearby = destroyableNearby.filter((bullet) => Math.random() < Math.max(0, Math.min(1, bullet.transferChance ?? 1)));

    if (transferableNearby.length > 0) {
      const targetCategory = side === 'left' ? 'player2' : 'player1';
      const targetSide = targetCategory === 'player1' ? 'left' : 'right';
      const targetPlayer = this.getPlayer(targetSide);
      const aimTarget = targetPlayer
        ? { x: targetPlayer.x + targetPlayer.width / 2, y: targetPlayer.y + targetPlayer.height / 2 }
        : undefined;

      transferableNearby.forEach(b => {
        const targetX = targetCategory === 'player1'
          ? Math.random() * (this.SCREEN_WIDTH * 0.45)
          : this.SCREEN_WIDTH * 0.55 + Math.random() * (this.SCREEN_WIDTH * 0.45);
        const targetY = Math.random() * (this.SCREEN_HEIGHT * 0.4);
        b.startTransfer(targetX, targetY, 750, targetCategory, targetSide, aimTarget);
        // 每传送一个子弹，给予触发该爆炸（也即击杀方）1 点基础蓄力，并按连击倍率加成
        if (side === 'left') {
          const combo1 = this.comboSystem1.getCombo();
          const mult1 = combo1 > 20 ? 2 : combo1 > 10 ? 1.5 : 1;
          this.chargeSystem1.addCharge(1 * mult1);
        } else {
          if (this.chargeSystem2 && this.comboSystem2) {
            const combo2 = this.comboSystem2.getCombo();
            const mult2 = combo2 > 20 ? 2 : combo2 > 10 ? 1.5 : 1;
            this.chargeSystem2.addCharge(1 * mult2);
          }
        }
      });
    }

    const destroyedBulletCount = Math.max(0, destroyableNearby.length - transferableNearby.length);
    if (destroyedBulletCount > 0) {
      this.getScoreSystem(side).addBulletClear(destroyedBulletCount);
    }
  }

  private onBossKilled(side: PlayerSide) {
    const comboSystem = this.getComboSystem(side);
    const scoreSystem = this.getScoreSystem(side);
    const chargeSystem = this.getChargeSystem(side);

    comboSystem.increment();
    scoreSystem.addBossKill();
    chargeSystem.addCharge(30);
  }
  
  triggerBoss(side: PlayerSide, aircraftType: AircraftType = 'scatter', skillTokenId?: number, ownerSide?: PlayerSide) {
    if (this.boss) {
      this.removeBoss();
    }
    this.spawnBoss(side, aircraftType, skillTokenId, ownerSide);
  }

  removeBoss() {
    if (this.boss) {
      const tokenId = this.boss.getSkillLifecycleId();
      this.boss.destroy();
      if (tokenId !== null) {
        this.boss.clearSkillLifecycleId();
        this.completeSkillEntity(tokenId);
      }
    }
    this.boss = null;
  }
  
  addBullet(bullet: Bullet) {
    if (!this.running) {
      return;
    }
    this.bullets.push(bullet);

    // Notify AI controllers immediately so they can react to new beam/laser spawns
    try {
      if (this.aiControllerLeft) {
        (this.aiControllerLeft as any).onBulletAdded?.(bullet);
      }
    } catch (e) {
      // swallow
    }

    try {
      if (this.aiControllerRight) {
        (this.aiControllerRight as any).onBulletAdded?.(bullet);
      }
    } catch (e) {
      // swallow
    }
  }
  
  addEnemy(enemy: Enemy) {
    if (!this.running) {
      return;
    }
    this.enemies.push(enemy);
  }
  
  getPlayer(side: PlayerSide): Player | null {
    return side === 'left' ? this.player1 : this.player2;
  }
  
  getEnemies(side: PlayerSide): Enemy[] {
    const result: Enemy[] = [];
    for (const enemy of this.enemies) {
      if (enemy.side === side) {
        result.push(enemy);
      }
    }
    return result;
  }
  
  getBullets(side: PlayerSide): Bullet[] {
    const result: Bullet[] = [];
    for (const bullet of this.bullets) {
      if (bullet.side === side) {
        result.push(bullet);
      }
    }
    return result;
  }
  
  getBoss(): Boss | null {
    return this.boss;
  }
  
  getScreenWidth(): number {
    return this.SCREEN_WIDTH;
  }
  
  getScreenHeight(): number {
    return this.SCREEN_HEIGHT;
  }
  
  getMargin(): number {
    return this.MARGIN;
  }

  getSideViewport(side: PlayerSide): { x: number; y: number; width: number; height: number } {
    const marginWidth = this.SCREEN_WIDTH * this.MARGIN / 2;
    const dividerLeft = this.SCREEN_WIDTH * 0.5 - marginWidth;
    const dividerRight = this.SCREEN_WIDTH * 0.5 + marginWidth;

    if (side === 'left') {
      return {
        x: 0,
        y: 0,
        width: dividerLeft,
        height: this.SCREEN_HEIGHT,
      };
    }

    return {
      x: dividerRight,
      y: 0,
      width: this.SCREEN_WIDTH - dividerRight,
      height: this.SCREEN_HEIGHT,
    };
  }

  private shouldCullBullet(bullet: Bullet): boolean {
    if (typeof bullet.isBeamLike === 'function' && bullet.isBeamLike()) {
      return false;
    }

    const screenHeight = this.SCREEN_HEIGHT;
    const viewport = this.getSideViewport(bullet.side);

    if (bullet.y + bullet.height < 0 || bullet.y > screenHeight) {
      return true;
    }

    return bullet.x < viewport.x || bullet.x + bullet.width > viewport.x + viewport.width;
  }

  private compactActiveEntities<T extends { active: boolean }>(entities: T[]) {
    let write = 0;
    for (let read = 0; read < entities.length; read++) {
      const entity = entities[read];
      if (!entity.active) {
        continue;
      }
      entities[write++] = entity;
    }
    entities.length = write;
  }

  hasActiveEnemies(): boolean {
    return this.enemies.some(e => e.active);
  }

  private finalizeMatchTraining(winner: 'left' | 'right' | 'draw') {
    const leftScore = this.getScoreShapingSnapshot('left');
    const rightScore = this.getScoreShapingSnapshot('right');

    this.pushTrainingEvent({
      game_event: 'game_end',
      winner,
      duration_ms: Math.max(0, this.runtime.dateNow() - this.matchStartTimestamp),
      left_health: this.player1.health,
      right_health: this.player2?.health ?? null,
      mode: this.gameMode,
      difficulty: this.aiDifficulty,
      left_total_score: leftScore.totalScore,
      left_combo_score: leftScore.comboScore,
      left_visible_score: leftScore.visibleScore,
      left_score_trend_penalty: leftScore.scoreTrendPenalty,
      left_score_trend_penalty_events: leftScore.scoreTrendPenaltyEvents,
      left_final_score_reward: leftScore.finalScoreReward,
      left_final_score_reward_total: leftScore.finalScoreRewardTotal,
      right_total_score: rightScore.totalScore,
      right_combo_score: rightScore.comboScore,
      right_visible_score: rightScore.visibleScore,
      right_score_trend_penalty: rightScore.scoreTrendPenalty,
      right_score_trend_penalty_events: rightScore.scoreTrendPenaltyEvents,
      right_final_score_reward: rightScore.finalScoreReward,
      right_final_score_reward_total: rightScore.finalScoreRewardTotal,
    });

    if (this.gameMode === 'selfplay' && this.trainingEvents.length > 0) {
      this.flushTrainingEventsToDownload({ format: 'jsonl', split: 'none', clearAfterFlush: false });
    }
  }

  private updateGameOverState() {
    // logging disabled

    if (this.gameOver) {
      return;
    }

    if (this.player1.health <= 0 && this.player2 && this.player2.health <= 0) {
      this.interruptCombo('left');
      if (this.scoreSystem2) {
        this.interruptCombo('right');
      }
      this.gameOver = true;
      this.winnerText = '平局';
      this.finalizeMatchTraining('draw');
      return;
    }

    if (this.player1.health <= 0) {
      this.interruptCombo('left');
      if (this.scoreSystem2) {
        this.interruptCombo('right');
      }
      this.gameOver = true;
      this.winnerText = this.gameMode === 'single' || this.gameMode === 'selfplay' ? '右侧获胜' : '右侧玩家获胜';
      this.finalizeMatchTraining('right');
      return;
    }

    if (this.player2 && this.player2.health <= 0) {
      this.interruptCombo('left');
      if (this.scoreSystem2) {
        this.interruptCombo('right');
      }
      this.gameOver = true;
      this.winnerText = this.gameMode === 'selfplay' ? '左侧获胜' : '左侧玩家获胜';
      this.finalizeMatchTraining('left');
    }
  }

  isGameOver(): boolean {
    return this.gameOver;
  }

  getWinnerText(): string {
    return this.winnerText;
  }

  getMatchSummary() {
    const summarizeSide = (side: PlayerSide) => {
      const comboSystem = this.getComboSystem(side);
      const chargeSystem = this.getChargeSystem(side);
      const score = this.getScoreShapingSnapshot(side);

      return {
        health: side === 'left' ? this.player1.health : this.player2?.health ?? null,
        totalScore: score.totalScore,
        comboScore: score.comboScore,
        visibleScore: score.visibleScore,
        combo: comboSystem.getCombo(),
        chargeMax: chargeSystem.getChargeMax(),
        currentCharge: chargeSystem.getCurrentCharge(),
        scoreTrendPenalty: score.scoreTrendPenalty,
        scoreTrendPenaltyEvents: score.scoreTrendPenaltyEvents,
        finalScoreReward: score.finalScoreReward,
        finalScoreRewardTotal: score.finalScoreRewardTotal,
      };
    };

    return {
      matchId: this.currentMatchId,
      episode: this.currentEpisode,
      seed: this.runSeed,
      mode: this.gameMode,
      difficulty: this.aiDifficulty,
      gameOver: this.gameOver,
      winnerText: this.winnerText,
      durationMs: Math.max(0, this.runtime.dateNow() - this.matchStartTimestamp),
      frames: this.simulationFrame,
      events: this.trainingEvents.length,
      left: summarizeSide('left'),
      right: summarizeSide('right'),
    };
  }
  
  private setupEventListeners() {
    if (this.listenersAttached) {
      return;
    }
    this.runtime.addWindowListener('keydown', this.keyDownListener);
    this.runtime.addWindowListener('keyup', this.keyUpListener);
    this.listenersAttached = true;
  }

  private removeEventListeners() {
    if (!this.listenersAttached) {
      return;
    }
    this.runtime.removeWindowListener('keydown', this.keyDownListener);
    this.runtime.removeWindowListener('keyup', this.keyUpListener);
    this.listenersAttached = false;
  }
  
  private handleKeyDown(e: KeyboardEvent) {
    if (this.gameMode === 'selfplay') {
      return;
    }

    switch (e.key) {
      case 'ArrowLeft':
        this.player1.movingLeft = true;
        break;
      case 'ArrowRight':
        this.player1.movingRight = true;
        break;
      case 'ArrowUp':
        this.player1.movingUp = true;
        break;
      case 'ArrowDown':
        this.player1.movingDown = true;
        break;
      case 'z':
      case 'Z':
        if (e.repeat) break;
        this.player1.onChargeKeyDown(this);
        break;
      case 'x':
      case 'X':
        this.player1.useBomb(this);
        break;
      case 'Shift':
        if (this.gameMode === 'single') {
          this.player1.setFocusMode(true);
        }
        break;
    }
    
    if (this.player2) {
      switch (e.key) {
        case 'a':
        case 'A':
          this.player2.movingLeft = true;
          break;
        case 'd':
        case 'D':
          this.player2.movingRight = true;
          break;
        case 'w':
        case 'W':
          this.player2.movingUp = true;
          break;
        case 's':
        case 'S':
          this.player2.movingDown = true;
          break;
        case 'j':
        case 'J':
          if (e.repeat) break;
          this.player2.onChargeKeyDown(this);
          break;
        case 'k':
        case 'K':
          this.player2.useBomb(this);
          break;
      }
    }
  }
  
  private handleKeyUp(e: KeyboardEvent) {
    if (this.gameMode === 'selfplay') {
      return;
    }

    switch (e.key) {
      case 'ArrowLeft':
        this.player1.movingLeft = false;
        break;
      case 'ArrowRight':
        this.player1.movingRight = false;
        break;
      case 'ArrowUp':
        this.player1.movingUp = false;
        break;
      case 'ArrowDown':
        this.player1.movingDown = false;
        break;
      case 'z':
      case 'Z':
        this.player1.onChargeKeyUp(this);
        break;
      case 'Shift':
        if (this.gameMode === 'single') {
          this.player1.setFocusMode(false);
        }
        break;
    }
    
    if (this.player2) {
      switch (e.key) {
        case 'a':
        case 'A':
          this.player2.movingLeft = false;
          break;
        case 'd':
        case 'D':
          this.player2.movingRight = false;
          break;
        case 'w':
        case 'W':
          this.player2.movingUp = false;
          break;
        case 's':
        case 'S':
          this.player2.movingDown = false;
          break;
        case 'j':
        case 'J':
          this.player2.onChargeKeyUp(this);
          break;
      }
    }
  }
}
