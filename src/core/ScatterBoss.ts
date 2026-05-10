import { Boss } from './Boss';
import { Game } from './Game';
import { PlayerSide } from '../entities/types';
import { emitPatternBullets } from './bullets/patternEmitter';

export class ScatterBoss extends Boss {
  private scatterPhase: 1 | 2 = 1;
  private phase1BurstTimer = 0;
  private phase1BulletsFired = 0;
  private phase1BaseAngleDeg = (Math.random() - 0.5) * 12;
  private readonly phase1BurstInterval = 120; // ms between bursts in phase 1
  private readonly phase1BurstSize = 8;
  private readonly phase1MaxBullets = 160;
  private readonly phase1SpreadDeg = 120;
  private readonly phase1BaseSpeed = 4;

  private phase2BurstTimer = 0;
  private phase2BurstsFired = 0;
  private phase2CooldownTimer = 0;
  private readonly phase2BurstInterval = 300; // ms between legacy scatter calls in phase 2
  private readonly phase2BurstCount = 7;

  constructor(x: number, y: number, side: PlayerSide) {
    super(x, y, side, 125);
  }

  protected override onUpdate(deltaTime: number, game: Game): void {
    if (this.scatterPhase === 1) {
      if (this.phase1BulletsFired === 0 && this.phase1BurstTimer === 0) {
        this.firePhase1Burst(game);
        return;
      }

      this.phase1BurstTimer += deltaTime;
      while (this.phase1BurstTimer >= this.phase1BurstInterval && this.phase1BulletsFired < this.phase1MaxBullets) {
        this.phase1BurstTimer -= this.phase1BurstInterval;
        this.firePhase1Burst(game);
      }

      if (this.phase1BulletsFired >= this.phase1MaxBullets) {
        this.enterPhase2();
      }

      return;
    }

    // phase 2: retain the legacy scatter rhythm as a fallback pattern
    if (this.scatterPhase === 2) {
      this.phase2BurstTimer += deltaTime;

      if (this.phase2BurstsFired < this.phase2BurstCount) {
        if (this.phase2BurstTimer >= this.phase2BurstInterval) {
          this.phase2BurstTimer -= this.phase2BurstInterval;
          this.shootScatterLegacy(game);
          this.phase2BurstsFired++;
        }
        return;
      }

      this.phase2CooldownTimer += deltaTime;
      if (this.phase2CooldownTimer >= 1000) {
        this.resetToPhase1();
      }
    }
  }

  private firePhase1Burst(game: Game) {
    const startX = this.x + this.width / 2;
    const startY = this.y + this.height / 2;
    const baseAngleDeg = this.phase1BaseAngleDeg;

    emitPatternBullets(
      {
        kind: 'fan',
        count: this.phase1BurstSize,
        centerDirectionDeg: baseAngleDeg,
        angleRangeDeg: this.phase1SpreadDeg,
        baseSpeed: this.phase1BaseSpeed,
        shape: 'circle',
      },
      {
        originX: startX,
        originY: startY,
        side: this.side,
        category: 'barrage',
        bulletType: 'normal',
        canBeDestroyed: true,
        transferChance: 0.1,
        width: 4,
        height: 10,
        damage: 10,
      },
      (bullet) => game.addBullet(bullet)
    );

    this.phase1BulletsFired += this.phase1BurstSize;

    // logging disabled: phase1 burst
    // keep `phase1BaseAngleDeg` constant during the phase (randomized on phase start)
  }

  private enterPhase2() {
    this.scatterPhase = 2;
    this.phase2BurstTimer = 0;
    this.phase2BurstsFired = 0;
    this.phase2CooldownTimer = 0;
  }

  private shootScatterLegacy(game: Game) {
    const centerX = this.x + this.width / 2;
    const originY = this.y + this.height / 2;
    emitPatternBullets(
      {
        kind: 'composite',
        patterns: [
          { kind: 'fan', count: 5, centerDirectionDeg: 0, angleRangeDeg: 58, baseSpeed: 4.25, shape: 'circle' },
          { kind: 'fan', count: 5, centerDirectionDeg: 0, angleRangeDeg: 74, baseSpeed: 5.35, shape: 'circle' },
          { kind: 'fan', count: 5, centerDirectionDeg: 0, angleRangeDeg: 80, baseSpeed: 5.9, shape: 'circle' },
        ],
      },
      {
        originX: centerX,
        originY,
        side: this.side,
        category: 'barrage',
        bulletType: 'normal',
        canBeDestroyed: true,
        transferChance: 0.1,
        width: 4,
        height: 10,
        damage: 10,
      },
      (bullet) => game.addBullet(bullet)
    );
  }

  private resetToPhase1() {
    this.scatterPhase = 1;
    this.phase1BurstTimer = 0;
    this.phase1BulletsFired = 0;
    this.phase1BaseAngleDeg = (Math.random() - 0.5) * 12;
    this.phase2BurstTimer = 0;
    this.phase2BurstsFired = 0;
    this.phase2CooldownTimer = 0;
  }
}
