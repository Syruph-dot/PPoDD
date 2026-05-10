import { BulletCategory, BulletType, PlayerSide } from '../../entities/types';

export type ChainDistribution = 'lerp' | 'random';
export type FanShape = 'circle' | 'line';

export type BulletSpawnDefaults = {
  side: PlayerSide;
  category: BulletCategory;
  bulletType: BulletType;
  canBeDestroyed: boolean;
  transferChance?: number;
  width: number;
  height: number;
  damage: number;
};

export type PatternSeed = BulletSpawnDefaults & {
  originX: number;
  originY: number;
  directionDeg?: number;
  defaultSpeed?: number;
};

export type BulletSpawnSpec = BulletSpawnDefaults & {
  x: number;
  y: number;
  directionDeg: number;
  speed: number;
};

export type BulletEmission = {
  delayMs: number;
  spec: BulletSpawnSpec;
};

export type PatternSingle = {
  kind: 'single';
  speed?: number;
  directionDeg?: number;
  offsetX?: number;
  offsetY?: number;
};

export type PatternChain = {
  kind: 'chain';
  count: number;
  baseSpeed: number;
  speedScale?: number;
  endSpeed?: number;
  distribution?: ChainDistribution;
  directionDeg?: number;
  intervalMs?: number;
  child?: BulletPattern;
};

export type PatternFan = {
  kind: 'fan';
  count: number;
  centerDirectionDeg?: number;
  angleRangeDeg: number;
  baseSpeed: number;
  shape?: FanShape;
  child?: BulletPattern;
};

export type BloomPattern = {
  kind: 'bloom';
  count: number;
  perBulletIntervalMs?: number;
  dThetaDeg: number;
  baseAngleDeg?: number;
  centerDirectionDeg?: number;
  baseSpeed: number;
  shape?: FanShape;
};

export type PatternComposite = {
  kind: 'composite';
  patterns: BulletPattern[];
};

export type BulletPattern = PatternSingle | PatternChain | PatternFan | BloomPattern | PatternComposite;
