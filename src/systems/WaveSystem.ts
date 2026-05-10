import { Game } from '../core/Game';
import { Enemy } from '../core/Enemy';
import { PlayerSide } from '../entities/types';

type Pattern = 'line' | 'v-shape' | 'circle' | 'random';

export class WaveSystem {
  private game: Game;
  private waveNumber = 0;
  private waveTimer = 0;
  // 波次间隔：从游戏开始的较长间隔逐渐减小到饱和值（频率上升）
  private readonly intervalStart = 2200; // ms, 初始较低频率（间隔较大）
  private readonly intervalEnd = 800; // ms, 饱和值（间隔较小，频率高）
  private readonly intervalRampDuration = 60000; // ms, 在此时间内完成从 start 到 end 的过渡
  private totalElapsed = 0; // 游戏开始至今的累计时间
  // 减少每波基数，让每个 pattern 敌人更稀疏
  private enemiesPerWave = 6;
  private hasSpawnedFirstWave = false;
  // 饱和增长参数：替代线性增长的额外敌人上限与特征波数
  private readonly maxAdditionalPerWave = 6;
  private readonly waveSaturation = 12;
  // 每侧同时存在的小怪上限，超过此数量将暂停生成
  private readonly maxActiveEnemiesPerSide = 14;
  
  constructor(game: Game) {
    this.game = game;
  }
  
  update(deltaTime: number) {
    // 统一按时间驱动刷怪，不再强制等待上一波清空
    this.waveTimer += deltaTime;
    this.totalElapsed += deltaTime;
    const currentInterval = this.getCurrentInterval();

    if (!this.hasSpawnedFirstWave) {
      if (this.waveTimer < currentInterval) return;
      this.waveTimer = 0;
      this.hasSpawnedFirstWave = true;
      this.spawnWave();
      return;
    }

    if (this.waveTimer >= currentInterval) {
      this.waveTimer = 0;
      this.spawnWave();
    }
  }

  private getCurrentInterval(): number {
    const progress = Math.min(1, this.totalElapsed / this.intervalRampDuration);
    // 线性插值从 intervalStart 到 intervalEnd
    return this.intervalStart + (this.intervalEnd - this.intervalStart) * progress;
  }
  
  private spawnWave() {
    this.waveNumber++;
    
    const pattern = this.getRandomPattern();
    
    this.spawnEnemiesForSide('left', pattern);
    this.spawnEnemiesForSide('right', pattern);
  }
  
  private getRandomPattern(): Pattern {
    const patterns: Pattern[] = ['line', 'v-shape', 'circle', 'random'];
    return patterns[Math.floor(Math.random() * patterns.length)];
  }
  
  private spawnEnemiesForSide(side: PlayerSide, pattern: Pattern) {
    const viewport = this.game.getSideViewport(side);
    const startX = viewport.x + viewport.width / 2;
    // 使用饱和增长曲线替代原来的线性增长（避免后期小怪无限增长）
    const additional = Math.floor(this.maxAdditionalPerWave * (1 - Math.exp(-this.waveNumber / this.waveSaturation)));
    const baseCount = this.enemiesPerWave + additional;
    let enemyCount = baseCount;

    // 根据不同 pattern 进一步调整本次刷怪数量（先计算再限流）
    switch (pattern) {
      case 'line':
        enemyCount = Math.max(4, Math.floor(baseCount * 0.6));
        break;
      case 'v-shape':
        enemyCount = Math.max(4, Math.floor(baseCount * 0.6));
        break;
      case 'circle':
        enemyCount = Math.max(5, Math.floor(baseCount * 0.5));
        break;
      case 'random':
        enemyCount = Math.max(3, Math.floor(baseCount * 0.5));
        break;
    }

    // 并发上限：限制每侧同时存在的小怪数量，避免后期刷怪数暴涨
    const activeEnemies = this.game.getEnemies(side).filter(e => e.active).length;
    const allowedToSpawn = Math.max(0, this.maxActiveEnemiesPerSide - activeEnemies);
    enemyCount = Math.min(enemyCount, allowedToSpawn);
    if (enemyCount <= 0) {
      return;
    }

    // 根据 pattern 真正生成
    switch (pattern) {
      case 'line':
        this.spawnLinePattern(startX, enemyCount, side);
        break;
      case 'v-shape':
        this.spawnVShapePattern(startX, enemyCount, side);
        break;
      case 'circle':
        this.spawnCirclePattern(startX, enemyCount, side);
        break;
      case 'random':
        this.spawnRandomPattern(startX, enemyCount, side, viewport);
        break;
    }
  }
  
  private spawnLinePattern(startX: number, count: number, side: PlayerSide) {
    // 为了容纳更大的敌机，增大横向间距
    const spacing = 60;
    const startXOffset = startX - (count / 2) * spacing;
    
    for (let i = 0; i < count; i++) {
      this.addEnemyClamped(startXOffset + i * spacing, -30 - i * 20, side);
    }
  }
  
  private spawnVShapePattern(startX: number, count: number, side: PlayerSide) {
    const halfCount = Math.floor(count / 2);

    // 增大横向/纵向间隔，避免较大体积的敌机重叠
    for (let i = 0; i < halfCount; i++) {
      this.addEnemyClamped(startX - i * 55, -30 - i * 35, side);
      this.addEnemyClamped(startX + i * 55, -30 - i * 35, side);
    }
  }
  
  private spawnCirclePattern(startX: number, count: number, side: PlayerSide) {
    // 圆形编队保持在版面外（顶部）生成，避免突然出现在版面中
    const radius = 130;
    const outsideTop = -80;
    
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 / count) * i;
      const x = startX + Math.cos(angle) * radius;
      const y = outsideTop - Math.abs(Math.sin(angle)) * radius;
      this.addEnemyClamped(x, y, side);
    }
  }
  
  private spawnRandomPattern(startX: number, count: number, side: PlayerSide,
                             viewport: { x: number; y: number; width: number; height: number }) {
    const halfWidth = viewport.width;
    
    for (let i = 0; i < count; i++) {
      this.addEnemyClamped(startX + (Math.random() - 0.5) * halfWidth, -30 - Math.random() * 100, side);
    }
  }

  private addEnemyClamped(x: number, y: number, side: PlayerSide) {
    const enemy = new Enemy(x, y, side);
    const viewport = this.game.getSideViewport(side);

    // 根据当前波数调整小怪血量分布（优先生成 2/4/6/8 生命值的敌人，随波数推进高血量概率上升）
    const healthOptions = [2, 4, 6, 8];
    const baseWeights = [0.6, 0.25, 0.1, 0.05];
    const endWeights = [0.05, 0.15, 0.3, 0.5];
    const progress = Math.min(1, this.waveNumber / 20);
    const weights = baseWeights.map((bw, i) => bw * (1 - progress) + endWeights[i] * progress);
    const total = weights.reduce((s, w) => s + w, 0);
    let r = Math.random() * total;
    let chosen = healthOptions[0];
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r <= 0) {
        chosen = healthOptions[i];
        break;
      }
    }
    enemy.health = chosen;
    enemy.maxHealth = chosen;

    enemy.x = Math.max(viewport.x, Math.min(enemy.x, viewport.x + viewport.width - enemy.width));
    // 强制初始刷怪点在顶部版面外，避免版面内瞬移出现
    enemy.y = Math.min(enemy.y, -enemy.height - 10);
    this.game.addEnemy(enemy);
  }
}
