import { Game } from './Game';
import { PlayerSide } from '../entities/types';
import { emitPatternBullets } from './bullets/patternEmitter';

const ENEMY_POLYGON_POINTS: Array<[number, number]> = [
  [0, -34], [22, -20], [34, 0], [22, 20], [0, 34], [-22, 20], [-34, 0], [-22, -20],
];

export type EnemyCollisionPoint = { x: number; y: number };

export class Enemy {
  x: number;
  y: number;
  // 小怪尺寸放大到 200%
  width = 96;
  height = 96;
  health = 2;
  maxHealth = 2;
  active = true;
  
  side: PlayerSide;
  // 提高默认移动速度，使敌机更具威胁
  // 以后可以由 WaveSystem 根据 waveNumber 动态放大
  private speed = 3.75;
  private lastShootTime = 0;
  private readonly shootCooldown = 2000;
  
  constructor(x: number, y: number, side: PlayerSide) {
    this.x = x;
    this.y = y;
    this.side = side;
  }
  
  update(_deltaTime: number, game: Game) {
    this.y += this.speed;

    // 离开屏幕后回收敌机，避免无形敌机阻塞下一波刷新
    if (this.y > game.getScreenHeight() + this.height) {
      this.active = false;
      return;
    }
    
    const currentTime = Date.now();
    if (currentTime - this.lastShootTime > this.shootCooldown && this.y < game.getScreenHeight() * 0.5) {
      this.lastShootTime = currentTime;
      this.shoot(game);
    }
  }
  
  render(ctx: CanvasRenderingContext2D) {
    const cx = this.x + this.width / 2;
    const cy = this.y + this.height / 2;
    // 小怪统一使用黄绿色（YellowGreen）配色，不再依据阵营
    const accent = '#9ACD32';
    const accentSoft = 'rgba(154, 205, 50, 0.22)';

    ctx.save();
    ctx.translate(cx, cy);
    ctx.shadowColor = accentSoft;
    ctx.shadowBlur = 12;

    ctx.fillStyle = 'rgba(8, 13, 26, 0.95)';
    this.drawPolygon(ctx, ENEMY_POLYGON_POINTS);
    ctx.fill();

    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    this.drawPolygon(ctx, ENEMY_POLYGON_POINTS);
    ctx.stroke();

    ctx.fillStyle = accentSoft;
    ctx.beginPath();
    ctx.moveTo(0, -24);
    ctx.lineTo(12, 0);
    ctx.lineTo(0, 20);
    ctx.lineTo(-12, 0);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#0b1020';
    ctx.beginPath();
    ctx.arc(0, 0, 10, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#eef4ff';
    ctx.font = '700 11px Microsoft YaHei';
    ctx.textAlign = 'center';
    ctx.fillText(`${this.health}`, 0, 4);

    ctx.restore();

    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(this.x + 14, this.y - 12, this.width - 28, 4);
    ctx.fillStyle = accent;
    ctx.fillRect(this.x + 14, this.y - 12, (this.width - 28) * Math.max(0, this.health / Math.max(1, this.maxHealth)), 4);
    ctx.restore();
  }

  getCollisionPolygon(): EnemyCollisionPoint[] {
    const cx = this.x + this.width / 2;
    const cy = this.y + this.height / 2;
    return ENEMY_POLYGON_POINTS.map(([px, py]) => ({
      x: cx + px,
      y: cy + py,
    }));
  }
  
  private shoot(game: Game) {
    emitPatternBullets(
      {
        kind: 'single',
        directionDeg: Math.random() * 74 - 37,
        speed: 5,
      },
      {
        originX: this.x + this.width / 2 - 2,
        originY: this.y + this.height,
        side: this.side,
        category: 'barrage',
        bulletType: 'normal',
        canBeDestroyed: true,
        width: 4,
        height: 10,
        damage: 10,
      },
      (bullet) => game.addBullet(bullet)
    );
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
