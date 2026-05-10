import { Boss } from './Boss';
import { Game } from './Game';
import { PlayerSide } from '../entities/types';
import { createBloomPattern, emitPatternBullets } from './bullets/patternEmitter';

type EmitterState = {
  offsetX: number;
  offsetY: number;
  vx: number;
  vy: number;
  burstTimer: number;
  burstAngleDeg: number;
};

export class TrackingBoss extends Boss {
  private emitters: EmitterState[] = [];
  private totalFired = 0;
  private sinceResample = 0;
  private cycleBulletsEmitted = 0;
  private restTimer = 0;
  private tThreshMs = 900;

  private readonly perBulletIntervalMs = 70;
  private readonly dThetaDeg = 73;
  private readonly bloomBurstSize = 9;
  private readonly bloomCooldownMs = 300;
  private readonly bloomRestMs = 2000;
  private readonly cycleBulletLimit = 200;
  private readonly baseBulletSpeed = 2.0;
  private readonly peakFactor = 1.5;
  private readonly accelMs = 500;
  private readonly decelMs = 500;

  constructor(x: number, y: number, side: PlayerSide) {
    super(x, y, side, 125);

    const halfWidth = this.width;
    this.emitters.push({
      offsetX: -Math.floor(halfWidth * 0.36),
      offsetY: 0,
      vx: 0,
      vy: 0,
      burstTimer: Math.random() * 600,
      burstAngleDeg: 0,
    });

    this.emitters.push({
      offsetX: Math.floor(halfWidth * 0.36),
      offsetY: 0,
      vx: 0,
      vy: 0,
      burstTimer: Math.random() * 600,
      burstAngleDeg: 0,
    });

    this.tThreshMs = Math.round((0.8 + Math.random() * 0.4) * 1000);
  }

  protected override onUpdate(deltaTime: number, game: Game): void {
    if (this.restTimer > 0) {
      this.restTimer = Math.max(0, this.restTimer - deltaTime);
    }

    for (const emitter of this.emitters) {
      this.updateEmitter(emitter, deltaTime, game);
    }
  }

  private updateEmitter(emitter: EmitterState, deltaTime: number, game: Game) {
    emitter.vx += (Math.random() - 0.5) * 0.06;
    emitter.vy += (Math.random() - 0.5) * 0.06;

    const maxSpeed = 0.9;
    const magnitude = Math.hypot(emitter.vx, emitter.vy);
    if (magnitude > maxSpeed) {
      emitter.vx = (emitter.vx / magnitude) * maxSpeed;
      emitter.vy = (emitter.vy / magnitude) * maxSpeed;
    }

    emitter.offsetX += emitter.vx * (deltaTime / (1000 / 60));
    emitter.offsetY += emitter.vy * (deltaTime / (1000 / 60));

    const limitX = Math.max(8, this.width * 0.45);
    const limitY = Math.max(6, this.height * 0.4);
    emitter.offsetX = Math.max(-limitX, Math.min(limitX, emitter.offsetX));
    emitter.offsetY = Math.max(-limitY, Math.min(limitY, emitter.offsetY));

    if (this.restTimer > 0) {
      return;
    }

    if (emitter.burstTimer > 0) {
      emitter.burstTimer -= deltaTime;
      return;
    }

    const remainingBudget = this.cycleBulletLimit - this.cycleBulletsEmitted;
    if (remainingBudget <= 0) {
      this.beginRest();
      return;
    }

    const burstCount = Math.min(this.bloomBurstSize, remainingBudget);
    this.emitBloomBurst(emitter, game, burstCount);
    this.cycleBulletsEmitted += burstCount;

    if (this.cycleBulletsEmitted >= this.cycleBulletLimit) {
      this.beginRest();
    }

    emitter.burstTimer = this.bloomCooldownMs + Math.max(0, burstCount - 1) * this.perBulletIntervalMs;
    emitter.burstAngleDeg = (Math.random() - 0.5) * 24;
  }

  private emitBloomBurst(emitter: EmitterState, game: Game, burstCount: number) {
    const centerX = this.x + this.width / 2;
    const centerY = this.y + this.height / 2;
    const originX = centerX + emitter.offsetX;
    const originY = centerY + emitter.offsetY;
    const tokenId = game.beginSkillLifecycle(this.side);
    const currentTThreshMs = this.tThreshMs;
    const pattern = createBloomPattern({
      count: burstCount,
      perBulletIntervalMs: this.perBulletIntervalMs,
      dThetaDeg: this.dThetaDeg,
      baseAngleDeg: emitter.burstAngleDeg,
      baseSpeed: this.baseBulletSpeed,
      shape: 'circle',
    });

    emitPatternBullets(
      pattern,
      {
        originX,
        originY,
        side: this.side,
        category: 'barrage',
        bulletType: 'normal',
        canBeDestroyed: true,
        width: 8,
        height: 16,
        damage: 10,
      },
      (bullet, delayMs) => {
        const seq = this.totalFired++;
        game.scheduleSkillLifecycleCallback(tokenId, () => {
          if (!bullet.active) {
            return;
          }

          game.addSkillBullet(bullet, tokenId);
          bullet.startAccelPulse(currentTThreshMs, this.accelMs, this.decelMs, this.peakFactor);

          if (seq % 2 === 0) {
            game.scheduleSkillLifecycleCallback(tokenId, () => {
              if (!bullet.active) {
                return;
              }

              const targetPlayer = game.getPlayer(bullet.side);
              if (targetPlayer) {
                bullet.aimAt(
                  targetPlayer.x + targetPlayer.width / 2,
                  targetPlayer.y + targetPlayer.height / 2,
                );
                return;
              }

              const viewport = game.getSideViewport(bullet.side);
              bullet.aimAt(
                viewport.x + viewport.width / 2,
                viewport.y + viewport.height / 2,
              );
            }, 500);
          }
        }, delayMs);
      }
    );

    this.sinceResample += burstCount;
    while (this.sinceResample >= 23) {
      this.sinceResample -= 23;
      this.tThreshMs = Math.round((0.8 + Math.random() * 0.4) * 1000);
    }
  }

  private beginRest() {
    this.restTimer = this.bloomRestMs;
    this.cycleBulletsEmitted = 0;
  }
}
