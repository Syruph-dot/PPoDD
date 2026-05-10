import { Boss } from './Boss';
import { Bullet } from './Bullet';
import { Game } from './Game';
import { PlayerSide } from '../entities/types';
import { createBulletFromSpawnSpec } from './bullets/patternEmitter';

type LaserBossMode = 'emitters' | 'beam-approach' | 'beam-sweep' | 'beam-return';

type BeamStage = 'approach' | 'sweep' | 'return';

type LaserEmitterState = {
  bullet: Bullet;
  shootAngleDeg: number;
  lastShootTime: number;
};

type BeamFollowTarget = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export class LaserBoss extends Boss {
  private mode: LaserBossMode = 'emitters';
  private beamStage: BeamStage = 'approach';

  private emitters: LaserEmitterState[] = [];
  private emitterWavesSpawned = 0;
  private lastEmitterWaveTime = 0;

  private readonly emitterWaveLimit = 2;
  private emitterWaveIntervalMs = 2000;
  private readonly emitterWindDownMs = 520;
  private emitterShootIntervalMs = 500;
  private readonly emitterSubBurstCount = 2;
  private readonly emitterSubBurstIntervalMs = 500;
  private readonly emitterRotateStepDeg = 137;
  private readonly emitterMoveSpeed = 3;
  private readonly emitterOrbDiameter = 42;
  private readonly emitterOutOfBoundsGraceMs = 900;

  private readonly emitterLaserSpeedPxPerSecond = 250;
  private readonly emitterLaserLengthPx = 50;
  private readonly emitterLaserThicknessPx = 8;

  private beamBullet: Bullet | null = null;
  private beamFollowTarget: BeamFollowTarget | null = null;
  private beamHomeX = 0;
  private beamStartX = 0;
  private beamEndX = 0;
  private beamLaneSide: 'left' | 'right' = 'left';
  private beamTravelSpeedPxPerSecond = 70;
  private beamReturnSpeedPxPerSecond = 320;
  private readonly beamThicknessPx = 24;
  private readonly beamDamage = 12;
  private readonly beamResetIntervalMs = 350;

  private patrolDirection = Math.random() < 0.5 ? -1 : 1;
  private readonly patrolSpeedPxPerSecond = 65;

  constructor(x: number, y: number, side: PlayerSide) {
    super(x, y, side, 125);
  }

  public setSkillIntensity(level: 2 | 3 | 4) {
    if (level === 4) {
      this.emitterWaveIntervalMs = 1200;
      this.emitterShootIntervalMs = 350;
    } else {
      this.emitterWaveIntervalMs = 2000;
      this.emitterShootIntervalMs = 500;
    }
  }

  override update(deltaTime: number, game: Game): void {
    if (!this.active) {
      return;
    }

    const viewport = game.getSideViewport(this.side);

    if (this.mode === 'emitters') {
      this.updateEmitterMode(deltaTime, game, viewport);
      return;
    }

    this.updateBeamMode(deltaTime, game, viewport);
  }

  override destroy() {
    this.clearEmitterState();
    this.clearBeamState();
  }

  private updateEmitterMode(deltaTime: number, game: Game, viewport: { x: number; y: number; width: number; height: number }) {
    this.patrolWithinViewport(deltaTime, viewport);

    this.emitters = this.emitters.filter((emitter) => emitter.bullet.active);

    const now = Date.now();
    if (this.emitterWavesSpawned < this.emitterWaveLimit) {
      const shouldSpawnWave = this.lastEmitterWaveTime === 0 || (now - this.lastEmitterWaveTime >= this.emitterWaveIntervalMs);
      if (shouldSpawnWave) {
        this.spawnEmitterWave(game, now);
      }
    }

    for (const emitter of this.emitters) {
      if (now - emitter.lastShootTime < this.emitterShootIntervalMs) {
        continue;
      }

      emitter.lastShootTime = now;
      this.fireEmitterBurst(game, emitter);
    }

    if (this.emitterWavesSpawned >= this.emitterWaveLimit && now - this.lastEmitterWaveTime >= this.emitterWindDownMs) {
      this.beginBeamMode(viewport);
    }
  }

  private updateBeamMode(deltaTime: number, game: Game, viewport: { x: number; y: number; width: number; height: number }) {
    if (this.beamStage === 'approach') {
      if (this.moveTowardsX(this.beamStartX, this.beamTravelSpeedPxPerSecond, deltaTime)) {
        this.spawnBeam(game, viewport);
        this.beamStage = 'sweep';
      }
      return;
    }

    if (this.beamStage === 'sweep') {
      if (this.moveTowardsX(this.beamEndX, this.beamTravelSpeedPxPerSecond, deltaTime)) {
        this.beamStage = 'return';
      }
      this.syncBeamGeometry(viewport);
      return;
    }

    if (this.moveTowardsX(this.beamHomeX, this.beamReturnSpeedPxPerSecond, deltaTime)) {
      this.syncBeamGeometry(viewport);
      this.endBeamMode();
      return;
    }

    this.syncBeamGeometry(viewport);
  }

  private spawnEmitterWave(game: Game, now: number) {
    const centerX = this.x + this.width / 2;
    const centerY = this.y + this.height / 2;
    const emitterOffsetX = Math.max(20, this.width * 0.18);
    const jitterDeg = (Math.random() - 0.5) * 36;
    const baseAngleDeg = -90 + jitterDeg;

    this.spawnEmitter(game, centerX - emitterOffsetX, centerY, baseAngleDeg, now);
    this.spawnEmitter(game, centerX + emitterOffsetX, centerY, baseAngleDeg + 180, now);

    this.emitterWavesSpawned += 1;
    this.lastEmitterWaveTime = now;
  }

  private spawnEmitter(game: Game, originX: number, originY: number, angleDeg: number, now: number) {
    const emitterRawSize = this.emitterOrbDiameter / 1.5;
    const emitterBullet = createBulletFromSpawnSpec({
      x: originX - this.emitterOrbDiameter / 2,
      y: originY - this.emitterOrbDiameter / 2,
      directionDeg: angleDeg,
      speed: this.emitterMoveSpeed,
      side: this.side,
      category: 'barrage',
      bulletType: 'special',
      canBeDestroyed: false,
      transferChance: 0,
      width: emitterRawSize,
      height: emitterRawSize,
      damage: 0,
    });

    emitterBullet.isCircular = true;
    emitterBullet.ownerSide = this.getVisualOwnerSide();
    emitterBullet.configureOutOfBoundsGracePeriod(this.emitterOutOfBoundsGraceMs);

    const tokenId = this.getSkillLifecycleId();
    if (typeof tokenId === 'number') {
      game.addSkillBullet(emitterBullet, tokenId);
    } else {
      game.addBullet(emitterBullet);
    }

    this.emitters.push({
      bullet: emitterBullet,
      shootAngleDeg: angleDeg,
      lastShootTime: now - this.emitterShootIntervalMs,
    });
  }

  private fireEmitterBurst(game: Game, emitter: LaserEmitterState) {
    const tokenId = this.getSkillLifecycleId();
    const baseAngleDeg = emitter.shootAngleDeg;
    const angleAdvancePerSubBurst = this.emitterRotateStepDeg * 3;

    for (let index = 0; index < this.emitterSubBurstCount; index++) {
      const scheduledStartAngle = this.normalizeAngleDeg(baseAngleDeg + index * angleAdvancePerSubBurst);
      const delayMs = index * this.emitterSubBurstIntervalMs;

      const callback = () => {
        if (!emitter.bullet.active) {
          return;
        }

        let angleDeg = scheduledStartAngle;
        for (let shot = 0; shot < 3; shot++) {
          this.fireMovingLaser(game, emitter.bullet, angleDeg);
          angleDeg = this.normalizeAngleDeg(angleDeg + this.emitterRotateStepDeg);
        }
      };

      if (typeof tokenId === 'number') {
        game.scheduleSkillLifecycleCallback(tokenId, callback, delayMs);
      } else {
        game.runWithLifecycle(callback, delayMs);
      }
    }

    emitter.shootAngleDeg = this.normalizeAngleDeg(baseAngleDeg + this.emitterSubBurstCount * angleAdvancePerSubBurst);
  }

  private fireMovingLaser(game: Game, emitterBullet: Bullet, angleDeg: number) {
    const originX = emitterBullet.x + emitterBullet.width / 2;
    const originY = emitterBullet.y + emitterBullet.height / 2;
    const viewport = game.getSideViewport(this.side);
    const laserBullet = new Bullet(
      originX,
      originY,
      0,
      0,
      'barrage',
      'special',
      false,
      this.emitterLaserThicknessPx,
      this.emitterLaserThicknessPx,
      10,
      this.side
    );

    laserBullet.startBouncingSegmentLaser(
      angleDeg,
      this.emitterLaserSpeedPxPerSecond,
      this.emitterLaserLengthPx,
      {
        minX: viewport.x,
        maxX: viewport.x + viewport.width,
        minY: viewport.y,
        maxY: viewport.y + viewport.height,
      },
      this.emitterLaserThicknessPx,
      Number.POSITIVE_INFINITY
    );
    laserBullet.isBossLaser = true;
    laserBullet.ownerSide = this.getVisualOwnerSide();

    const tokenId = this.getSkillLifecycleId();
    if (typeof tokenId === 'number') {
      game.addSkillBullet(laserBullet, tokenId);
    } else {
      game.addBullet(laserBullet);
    }
  }

  private beginBeamMode(viewport: { x: number; y: number; width: number; height: number }) {
    this.clearEmitterState();
    this.mode = 'beam-approach';
    this.beamStage = 'approach';
    this.beamHomeX = this.x;
    this.beamLaneSide = Math.random() < 0.5 ? 'left' : 'right';

    const startCenterX = this.getLaneCenterX(viewport, this.beamLaneSide);
    const endCenterX = this.getLaneCenterX(viewport, this.beamLaneSide === 'left' ? 'right' : 'left');
    this.beamStartX = this.clampBossLeftX(startCenterX - this.width / 2, viewport);
    this.beamEndX = this.clampBossLeftX(endCenterX - this.width / 2, viewport);

    // Keep the boss beam aligned to the new lane as soon as it spawns.
    this.beamFollowTarget = {
      x: this.x + this.width / 2,
      y: 0,
      width: 0,
      height: 0,
    };
  }

  private spawnBeam(game: Game, viewport: { x: number; y: number; width: number; height: number }) {
    const followTarget: BeamFollowTarget = {
      x: this.x + this.width / 2,
      y: 0,
      width: 0,
      height: 0,
    };

    const beamBullet = new Bullet(
      followTarget.x - this.beamThicknessPx / 2,
      viewport.y,
      0,
      0,
      'barrage',
      'special',
      false,
      this.beamThicknessPx,
      this.beamThicknessPx,
      this.beamDamage,
      this.side
    );

    beamBullet.ownerSide = this.getVisualOwnerSide();
    beamBullet.isBossLaser = true;
    beamBullet.startLaser(
      followTarget,
      Number.POSITIVE_INFINITY,
      this.beamResetIntervalMs,
      this.beamThicknessPx,
      {
        origin: 'bottom',
        originY: viewport.y + viewport.height,
        followX: true,
      }
    );

    // 设置光束的扫描速度，让AI可以预测光束移动方向
    const sweepDirection = Math.sign(this.beamEndX - this.beamStartX);
    beamBullet.vx = (sweepDirection * this.beamTravelSpeedPxPerSecond) / 60;

    this.beamBullet = beamBullet;
    this.beamFollowTarget = followTarget;
    this.syncBeamGeometry(viewport);

    const tokenId = this.getSkillLifecycleId();
    if (typeof tokenId === 'number') {
      game.addSkillBullet(beamBullet, tokenId);
    } else {
      game.addBullet(beamBullet);
    }
  }

  private syncBeamGeometry(viewport: { x: number; y: number; width: number; height: number }) {
    if (!this.beamBullet || !this.beamFollowTarget) {
      return;
    }

    const centerX = this.x + this.width / 2;
    this.beamFollowTarget.x = centerX;
    this.beamFollowTarget.y = 0;
    this.beamFollowTarget.width = 0;
    this.beamFollowTarget.height = 0;

    this.beamBullet.x = centerX - this.beamThicknessPx / 2;
    this.beamBullet.y = viewport.y;
    this.beamBullet.width = this.beamThicknessPx;
    this.beamBullet.height = viewport.height;
  }

  private endBeamMode() {
    this.clearBeamState();
    this.mode = 'emitters';
    this.beamStage = 'approach';
    this.emitterWavesSpawned = 0;
    this.lastEmitterWaveTime = 0;
  }

  private clearEmitterState() {
    for (const emitter of this.emitters) {
      emitter.bullet.active = false;
    }

    this.emitters = [];
    this.emitterWavesSpawned = 0;
    this.lastEmitterWaveTime = 0;
  }

  private clearBeamState() {
    if (this.beamBullet) {
      this.beamBullet.active = false;
    }

    this.beamBullet = null;
    this.beamFollowTarget = null;
  }

  private patrolWithinViewport(deltaTime: number, viewport: { x: number; y: number; width: number; height: number }) {
    const minX = viewport.x + 12;
    const maxX = viewport.x + viewport.width - this.width - 12;
    const step = this.patrolSpeedPxPerSecond * (deltaTime / 1000);

    this.x += this.patrolDirection * step;

    if (this.x <= minX) {
      this.x = minX;
      this.patrolDirection = 1;
      return;
    }

    if (this.x >= maxX) {
      this.x = maxX;
      this.patrolDirection = -1;
    }
  }

  private moveTowardsX(targetX: number, speedPxPerSecond: number, deltaTime: number): boolean {
    const maxStep = speedPxPerSecond * (deltaTime / 1000);
    const distance = targetX - this.x;

    if (Math.abs(distance) <= maxStep) {
      this.x = targetX;
      return true;
    }

    this.x += Math.sign(distance) * maxStep;
    return false;
  }

  private clampBossLeftX(value: number, viewport: { x: number; y: number; width: number; height: number }): number {
    const minX = viewport.x + 12;
    const maxX = viewport.x + viewport.width - this.width - 12;
    return Math.max(minX, Math.min(maxX, value));
  }

  private getLaneCenterX(viewport: { x: number; y: number; width: number; height: number }, laneSide: 'left' | 'right'): number {
    const laneCenter = laneSide === 'left'
      ? viewport.x + viewport.width * 0.2
      : viewport.x + viewport.width * 0.8;

    const minCenter = viewport.x + this.width / 2 + 12;
    const maxCenter = viewport.x + viewport.width - this.width / 2 - 12;
    return Math.max(minCenter, Math.min(maxCenter, laneCenter));
  }

  private getVisualOwnerSide(): PlayerSide {
    return this.ownerSide ?? this.side;
  }

  private normalizeAngleDeg(angleDeg: number): number {
    let normalized = ((angleDeg % 360) + 360) % 360;
    if (normalized > 180) {
      normalized -= 360;
    }
    return normalized;
  }
}