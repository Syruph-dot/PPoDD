import { Bullet } from '../Bullet';
import {
  BulletEmission,
  BulletPattern,
  BulletSpawnSpec,
  BloomPattern,
  PatternChain,
  PatternFan,
  PatternSeed,
  PatternSingle,
} from './types';

type InternalSeed = PatternSeed & {
  delayMs: number;
};

const clampCount = (count: number): number => Math.max(1, Math.floor(count));

const resolveDirection = (preferred: number | undefined, fallback: number | undefined): number => {
  if (typeof preferred === 'number') {
    return preferred;
  }
  if (typeof fallback === 'number') {
    return fallback;
  }
  return 180;
};

const resolveSingle = (node: PatternSingle, seed: InternalSeed): BulletEmission => {
  const directionDeg = resolveDirection(node.directionDeg, seed.directionDeg);
  const speed = typeof node.speed === 'number' ? node.speed : (seed.defaultSpeed ?? 6);

  const spec: BulletSpawnSpec = {
    x: seed.originX + (node.offsetX ?? 0),
    y: seed.originY + (node.offsetY ?? 0),
    directionDeg,
    speed,
    side: seed.side,
    category: seed.category,
    bulletType: seed.bulletType,
    canBeDestroyed: seed.canBeDestroyed,
    transferChance: seed.transferChance,
    width: seed.width,
    height: seed.height,
    damage: seed.damage,
  };

  return {
    delayMs: seed.delayMs,
    spec,
  };
};

const chainSpeedAt = (node: PatternChain, index: number, count: number): number => {
  const baseSpeed = node.baseSpeed;
  const speedScale = typeof node.speedScale === 'number' ? node.speedScale : 1;
  const endSpeed = typeof node.endSpeed === 'number' ? node.endSpeed : undefined;
  const mode = node.distribution ?? 'lerp';

  if (typeof endSpeed === 'number') {
    if (mode === 'random') {
      const minSpeed = Math.min(baseSpeed, endSpeed);
      const maxSpeed = Math.max(baseSpeed, endSpeed);
      return minSpeed + Math.random() * (maxSpeed - minSpeed);
    }

    if (count <= 1) {
      return baseSpeed;
    }

    const t = index / (count - 1);
    return baseSpeed + (endSpeed - baseSpeed) * t;
  }

  return baseSpeed * Math.pow(speedScale, index);
};

const fanAngles = (node: PatternFan): number[] => {
  const count = clampCount(node.count);
  const center = typeof node.centerDirectionDeg === 'number' ? node.centerDirectionDeg : 180;
  const spread = Math.max(0, node.angleRangeDeg);

  if (count === 1) {
    return [center];
  }

  const start = center - spread / 2;
  const step = spread / (count - 1);
  const angles: number[] = [];
  for (let i = 0; i < count; i++) {
    angles.push(start + step * i);
  }
  return angles;
};

const fanSpeedFor = (node: PatternFan, angleDeg: number): number => {
  const shape = node.shape ?? 'circle';
  const center = typeof node.centerDirectionDeg === 'number' ? node.centerDirectionDeg : 180;
  const offsetRad = ((angleDeg - center) * Math.PI) / 180;

  if (shape === 'line') {
    const cosValue = Math.cos(offsetRad);
    const safeCos = Math.abs(cosValue) < 0.15 ? (cosValue < 0 ? -0.15 : 0.15) : cosValue;
    return node.baseSpeed / safeCos;
  }

  return node.baseSpeed;
};

const bloomEmissions = (node: BloomPattern, seed: InternalSeed): BulletEmission[] => {
  const count = clampCount(node.count);
  const interval = Math.max(0, node.perBulletIntervalMs ?? 70);
  const baseDirection = typeof node.baseAngleDeg === 'number'
    ? node.baseAngleDeg
    : resolveDirection(node.centerDirectionDeg, seed.directionDeg);
  const speed = node.baseSpeed;

  const emissions: BulletEmission[] = [];
  for (let i = 0; i < count; i++) {
    emissions.push({
      delayMs: seed.delayMs + i * interval,
      spec: {
        x: seed.originX,
        y: seed.originY,
        directionDeg: baseDirection + i * node.dThetaDeg,
        speed,
        side: seed.side,
        category: seed.category,
        bulletType: seed.bulletType,
        canBeDestroyed: seed.canBeDestroyed,
        transferChance: seed.transferChance,
        width: seed.width,
        height: seed.height,
        damage: seed.damage,
      },
    });
  }

  return emissions;
};

export const createBloomPattern = (options: {
  count: number;
  perBulletIntervalMs?: number;
  dThetaDeg: number;
  baseAngleDeg?: number;
  centerDirectionDeg?: number;
  baseSpeed: number;
  shape?: 'circle' | 'line';
}): BloomPattern => {
  return {
    kind: 'bloom',
    count: clampCount(options.count),
    perBulletIntervalMs: Math.max(0, options.perBulletIntervalMs ?? 70),
    dThetaDeg: options.dThetaDeg,
    baseAngleDeg: options.baseAngleDeg,
    centerDirectionDeg: options.centerDirectionDeg,
    baseSpeed: options.baseSpeed,
    shape: options.shape,
  };
};

const flatten = (pattern: BulletPattern, seed: InternalSeed): BulletEmission[] => {
  if (pattern.kind === 'single') {
    return [resolveSingle(pattern, seed)];
  }

  if (pattern.kind === 'composite') {
    const all: BulletEmission[] = [];
    for (const child of pattern.patterns) {
      all.push(...flatten(child, seed));
    }
    return all;
  }

  if (pattern.kind === 'chain') {
    const count = clampCount(pattern.count);
    const interval = Math.max(0, pattern.intervalMs ?? 0);
    const directionDeg = resolveDirection(pattern.directionDeg, seed.directionDeg);
    const all: BulletEmission[] = [];

    for (let i = 0; i < count; i++) {
      const chainSeed: InternalSeed = {
        ...seed,
        delayMs: seed.delayMs + i * interval,
        directionDeg,
        defaultSpeed: chainSpeedAt(pattern, i, count),
      };

      if (pattern.child) {
        all.push(...flatten(pattern.child, chainSeed));
      } else {
        all.push(...flatten({ kind: 'single' }, chainSeed));
      }
    }

    return all;
  }

  if (pattern.kind === 'bloom') {
    return bloomEmissions(pattern, seed);
  }

  const angles = fanAngles(pattern);
  const all: BulletEmission[] = [];

  for (const angle of angles) {
    const fanSeed: InternalSeed = {
      ...seed,
      directionDeg: angle,
      defaultSpeed: fanSpeedFor(pattern, angle),
    };

    if (pattern.child) {
      all.push(...flatten(pattern.child, fanSeed));
    } else {
      all.push(...flatten({ kind: 'single' }, fanSeed));
    }
  }

  return all;
};

export const createBulletFromSpawnSpec = (spec: BulletSpawnSpec): Bullet => {
  const angleRad = (spec.directionDeg * Math.PI) / 180;
  const vx = Math.sin(angleRad) * spec.speed;
  const vy = Math.cos(angleRad) * spec.speed;

  return new Bullet(
    spec.x,
    spec.y,
    vx,
    vy,
    spec.category,
    spec.bulletType,
    spec.canBeDestroyed,
    spec.width,
    spec.height,
    spec.damage,
    spec.side,
    spec.transferChance ?? 1
  );
};

export const buildPatternEmissions = (pattern: BulletPattern, seed: PatternSeed): BulletEmission[] => {
  return flatten(pattern, { ...seed, delayMs: 0 });
};

export const emitPatternBullets = (
  pattern: BulletPattern,
  seed: PatternSeed,
  emit: (bullet: Bullet, delayMs: number) => void
): void => {
  const emissions = buildPatternEmissions(pattern, seed);
  for (const emission of emissions) {
    emit(createBulletFromSpawnSpec(emission.spec), emission.delayMs);
  }
};
