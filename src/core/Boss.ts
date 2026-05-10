import { Game } from './Game';
import { PlayerSide } from '../entities/types';

export abstract class Boss {
  x: number;
  y: number;
  width = 200;
  height = 200;
  health: number;
  maxHealth: number;
  active = true;
  
  side: PlayerSide;
  ownerSide: PlayerSide | null = null;
  protected speed = 1;
  protected moveDirection = 1;
  private skillLifecycleId: number | null = null;
  private spawnInvulnerableUntilMs = 0;

  constructor(x: number, y: number, side: PlayerSide, maxHealth = 125) {
    this.x = x;
    this.y = y;
    this.side = side;
    this.maxHealth = maxHealth;
    this.health = maxHealth;
    this.setSpawnInvulnerability(650);
  }

  update(deltaTime: number, game: Game) {
    this.x += this.speed * this.moveDirection;

    const screenWidth = game.getScreenWidth();
    const margin = game.getMargin();

    if (this.side === 'left') {
      if (this.x <= 0 || this.x >= screenWidth * (0.5 - margin / 2) - this.width) {
        this.moveDirection *= -1;
      }
    } else {
      if (this.x <= screenWidth * (0.5 + margin / 2) || 
          this.x >= screenWidth - this.width) {
        this.moveDirection *= -1;
      }
    }

    this.onUpdate(deltaTime, game);
  }

  protected onUpdate(_deltaTime: number, _game: Game): void {
    // override in subclasses for per-boss firing logic
  }

  attachSkillLifecycle(skillLifecycleId: number) {
    this.skillLifecycleId = skillLifecycleId;
  }

  getSkillLifecycleId(): number | null {
    return this.skillLifecycleId;
  }

  clearSkillLifecycleId() {
    this.skillLifecycleId = null;
  }

  destroy() {
    // Override in subclasses that own persistent attack bullets.
  }

  setSpawnInvulnerability(durationMs: number) {
    this.spawnInvulnerableUntilMs = performance.now() + Math.max(0, durationMs);
  }

  canTakeDamage(nowMs = performance.now()): boolean {
    return this.active && this.health > 0 && nowMs >= this.spawnInvulnerableUntilMs;
  }

  render(ctx: CanvasRenderingContext2D) {
    const cx = this.x + this.width / 2;
    const cy = this.y + this.height / 2;
    // Boss color intentionally inverted: left side bosses display red, right side blue
    const accent = this.side === 'left' ? '#ff6f8e' : '#59f0ff';
    const aura = this.side === 'left' ? 'rgba(255, 111, 142, 0.22)' : 'rgba(89, 240, 255, 0.22)';

    ctx.save();
    ctx.translate(cx, cy);
    ctx.shadowColor = aura;
    ctx.shadowBlur = 16;

    ctx.fillStyle = 'rgba(7, 12, 24, 0.98)';
    this.drawPolygon(ctx, [
      [0, -36], [26, -24], [40, 0], [26, 24], [0, 36], [-26, 24], [-40, 0], [-26, -24],
    ]);
    ctx.fill();

    ctx.strokeStyle = accent;
    ctx.lineWidth = 2.5;
    this.drawPolygon(ctx, [
      [0, -36], [26, -24], [40, 0], [26, 24], [0, 36], [-26, 24], [-40, 0], [-26, -24],
    ]);
    ctx.stroke();

    ctx.fillStyle = aura;
    ctx.beginPath();
    ctx.moveTo(0, -26);
    ctx.lineTo(16, -2);
    ctx.lineTo(0, 18);
    ctx.lineTo(-16, -2);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#eef4ff';
    ctx.font = '700 14px Microsoft YaHei';
    ctx.textAlign = 'center';
    ctx.fillText(`Boss ${this.health}/${this.maxHealth}`, 0, -48);

    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(-44, 48, 88, 8);
    ctx.fillStyle = accent;
    ctx.fillRect(-44, 48, 88 * Math.max(0, this.health / this.maxHealth), 8);
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = 1;
    ctx.strokeRect(-44, 48, 88, 8);

    ctx.restore();
  }

  private drawPolygon(ctx: CanvasRenderingContext2D, points: Array<[number, number]>) {
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i][0], points[i][1]);
    }
    ctx.closePath();
  }
}
