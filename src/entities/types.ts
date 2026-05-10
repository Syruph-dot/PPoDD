import type { PolicyDecisionProvider } from '../systems/policy/types';

export type PlayerSide = 'left' | 'right';

export type AircraftType = 'scatter' | 'laser' | 'tracking';

export type Difficulty = 'easy' | 'normal' | 'hard';

export type GameMode = 'single' | 'dual' | 'selfplay';

export interface GameConfig {
  mode: GameMode;
  difficulty: Difficulty;
  player1Aircraft: AircraftType;
  player2Aircraft?: AircraftType;
  seed?: string | number;
  agentIds?: Partial<Record<PlayerSide, string>>;
  agentPolicies?: Partial<Record<PlayerSide, PolicyDecisionProvider | null>>;
  trainingConfig?: Record<string, unknown>;
  headless?: boolean;
  runtime?: unknown;
}

export interface Position {
  x: number;
  y: number;
}

export interface Velocity {
  vx: number;
  vy: number;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

// 子弹大类
export type BulletCategory = 'player1' | 'player2' | 'barrage';

// 子弹类型（玩家子弹用：普通/特殊）
export type BulletType = 'normal' | 'special';

export interface PlayerState {
  pos: Position;
  vel: Velocity;
  health: number;
  bombs?: number;
  isCharging?: boolean;
  currentCharge?: number;
  chargeMax?: number;
  side?: PlayerSide;
}

export interface EnemySlot {
  pos: Position;
  width: number;
  height: number;
  health: number;
  maxHealth: number;
}

export interface BulletSlot {
  pos: Position;
  vel: Velocity;
  width: number;
  height: number;
  damage?: number;
  category: BulletCategory;
  bulletType?: BulletType;
  side: PlayerSide;
  isBeamLike?: boolean;
  isWarning?: boolean;
  canBeDestroyed?: boolean;
  isCircular?: boolean;
}

export interface BossState {
  pos: Position;
  width: number;
  height: number;
  health: number;
  maxHealth: number;
  active: boolean;
  canTakeDamage?: boolean;
  side?: PlayerSide;
}

export interface Observation {
  self: PlayerState;
  opponent?: PlayerState | null;
  enemies: EnemySlot[];
  bullets: BulletSlot[];
  boss?: BossState | null;
  arena: {
    currentThreat: number;
    nearbyBulletCount: number;
    decisionIntervalMs: number;
  };
  screen: { width: number; height: number; margin: number };
  tick_ms?: number;
  decision_interval_ms?: number;
}
