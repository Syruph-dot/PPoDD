import { BulletCategory, BulletType, PlayerSide } from '../entities/types';

export class Bullet {
  x: number;
  y: number;
  width = 4;
  height = 10;
  vx: number;
  vy: number;
  active = true;
  // 标记此子弹是否被扩张力场消除（用于决定是否计入蓄力）
  destroyedByExpandingField = false;

  // 记录此子弹对目标的最后命中时间（ms），用于实现可恢复的命中冷却
  private hitTimestamps: WeakMap<object, number> = new WeakMap<object, number>();

  category: BulletCategory;
  bulletType: BulletType;
  canBeDestroyed: boolean;
  transferChance: number;
  damage: number;
  side: PlayerSide;  // 弹幕需要side来标识属于哪方
  ownerSide: PlayerSide | null = null;

  private _moveDirX = 0;
  private _moveDirY = 1;
  private _baseSpeed = 0;
  private _accelPulse: {
    delayMs: number;
    elapsedMs: number;
    accelMs: number;
    decelMs: number;
    baseSpeed: number;
    peakSpeed: number;
  } | null = null;

  private isTransferring = false;
  private transferTime = 0;
  private transferDuration = 750;
  private targetX = 0;
  private targetY = 0;
  private startX = 0;
  private startY = 0;
  private postTransferAimTarget: { x: number; y: number } | null = null;
  // 可选的传送缓动方式（用于光球先快后慢）
  private transferEasing: 'linear' | 'easeOutQuad' = 'linear';

  // Laser-specific state: 持续型激光，跟随一个目标（通常是发射者），持续若干毫秒，并按间隔重置命中记录以允许重复受击
  private isLaser = false;
  private laserDuration = 1500; // ms
  private laserElapsed = 0;
  private laserResetInterval = 400; // ms
  private followTarget: { x: number; y: number; width: number; height: number } | null = null;
  // 报警 / 预警标记（用于在屏幕上闪烁提示，不造成伤害）
  isWarning = false;
  // 如果设置为数字（0..1），渲染预警时使用该固定 alpha，
  // 否则回退到默认的脉动效果。
  warningAlpha?: number;
  // 标记此子弹应以圆形光球形式渲染（用于 Skill3 之类的效果）
  isCircular = false;
  // 支持基于时间的预警淡入（用于光球到达后逐渐显示预警）
  private warningDurationMs = 0;
  private warningElapsedMs = 0;
  private warningTargetAlpha = 0.5;
  // 激光扩展方向与参数
  private laserOrigin: 'top' | 'bottom' = 'top';
  private laserOriginY = -10; // 对于 bottom-origin 的激光，设置起点 Y
  private laserFadeDuration = 150; // ms，用于在激光结束前淡出
  private laserFollowX = true; // 是否随 followTarget 的 X 轴移动

  // 越界保留时间：用于“出屏后延迟删除”的发射器
  private outOfBoundsGracePeriod = 0;
  private outOfBoundsSince: number | null = null;

  // 线段激光：激光头先移动，激光尾按长度/速度推导的延迟开始移动
  private isSegmentLaser = false;
  private segmentOriginX = 0;
  private segmentOriginY = 0;
  private segmentDirX = 0;
  private segmentDirY = 1;
  private segmentSpeedPxPerSecond = 0;
  private segmentLengthPx = 0;
  private segmentTailDelayMs = 0;
  private segmentElapsedMs = 0;
  private segmentLifetimeMs = 2000;
  private segmentThicknessPx = 8;
  private segmentHeadX = 0;
  private segmentHeadY = 0;
  private segmentTailX = 0;
  private segmentTailY = 0;
  private segmentState: 'normal' | 'wait-tail-at-bounce' | 'wait-gap-after-bounce' | 'post-bounce-follow' = 'normal';
  private segmentHeadPostBounceDistancePx = 0;
  private segmentTailPostBounceDistancePx = 0;
  private segmentBounceEnabled = false;
  private segmentHasBounced = false;
  private segmentBounds: { minX: number; maxX: number; minY: number; maxY: number } | null = null;
  private segmentBouncePointX = 0;
  private segmentBouncePointY = 0;
  private segmentHeadDistanceAtBouncePx = 0;
  private segmentTailDistanceAtBouncePx = 0;
  private segmentPreBounceDirX = 0;
  private segmentPreBounceDirY = 1;
  private segmentPostBounceDirX = 0;
  private segmentPostBounceDirY = 1;
  private skillLifecycleId: number | null = null;
  isBossLaser = false;

  constructor(x: number, y: number, vx: number, vy: number,
              category: BulletCategory, bulletType: BulletType,
              canBeDestroyed: boolean,
              width = 4, height = 10, damage = 10,
              side: PlayerSide = 'left',
              transferChance = 1) {
    this.x = x;
    this.y = y;
    this.vx = vx;
    this.vy = vy;
    this.category = category;
    this.bulletType = bulletType;
    this.canBeDestroyed = canBeDestroyed;
    this.transferChance = Math.max(0, Math.min(1, transferChance));
    if (category === 'barrage') {
      this.width = width * 1.5;
      this.height = height * 1.5;
      this.vx = vx * 0.75;
      this.vy = vy * 0.75;
    } else {
      this.width = width;
      this.height = height;
    }
    this.damage = damage;
    this.side = side;
    this.syncMotionStateFromVelocity();
  }

  update(deltaTime: number) {
    // 处理预警淡入
    if (this.isWarning && this.warningDurationMs > 0) {
      this.warningElapsedMs += deltaTime;
      const t = Math.max(0, Math.min(1, this.warningElapsedMs / this.warningDurationMs));
      this.warningAlpha = Math.min(this.warningTargetAlpha, t * this.warningTargetAlpha);
    }
    if (this.isTransferring) {
      this.transferTime += deltaTime;

      if (this.transferTime >= this.transferDuration) {
        this.x = this.targetX;
        this.y = this.targetY;
        this.isTransferring = false;
        this.transferTime = 0;

        const speed = (3 + Math.random() * 5) * 0.75;
        // 随机角弹：33% 概率朝该版面玩家方向，附加左右 ±16° 偏移；其余保持原始散射。
        const aimOffsetDeg = 16;
        let angleDeg: number;
        if (this.postTransferAimTarget && Math.random() < 0.33) {
          const targetDx = this.postTransferAimTarget.x - this.x;
          const targetDy = this.postTransferAimTarget.y - this.y;
          const targetAngleRad = Math.atan2(targetDx, targetDy);
          const targetAngleDeg = (targetAngleRad * 180) / Math.PI;
          angleDeg = targetAngleDeg + (Math.random() * (aimOffsetDeg * 2) - aimOffsetDeg);
        } else {
          const maxAngleDeg = 37;
          angleDeg = Math.random() * (maxAngleDeg * 2) - maxAngleDeg;
        }
        const angle = (angleDeg * Math.PI) / 180;
        // 使用 (sin, cos) 映射，使 angle=0 时向下
        this.vx = Math.sin(angle) * speed;
        this.vy = Math.cos(angle) * speed;
        this.postTransferAimTarget = null;
      } else {
        const p = this.transferTime / this.transferDuration;
        let progress = p;
        if (this.transferEasing === 'easeOutQuad') {
          progress = 1 - (1 - p) * (1 - p);
        }
        this.x = this.startX + (this.targetX - this.startX) * progress;
        this.y = this.startY + (this.targetY - this.startY) * progress;
      }
    } else {
      if (this.isSegmentLaser) {
        this.updateSegmentLaser(deltaTime);
      } else if (this.isLaser) {
        // 激光每帧更新计时器并跟随发射者位置（可选择是否跟随 X），激光可以从顶部或底部延伸到目标中心位置
        this.laserElapsed += deltaTime;

        if (this.followTarget) {
          const centerX = this.followTarget.x + this.followTarget.width / 2;
          const centerY = this.followTarget.y + this.followTarget.height / 2;
          if (this.laserFollowX) {
            this.x = centerX - this.width / 2;
          }

          if (this.laserOrigin === 'top') {
            // 从屏幕顶部向下延伸，起点略在屏幕外
            this.y = -10;
            this.height = Math.max(4, centerY - this.y);
          } else {
            // 从屏幕底部向上延伸：激光的矩形应从目标中心开始，向下延伸到屏幕底部
            this.y = Math.max(0, Math.min(centerY, this.laserOriginY - 4));
            this.height = Math.max(4, this.laserOriginY - centerY);
          }
        }

        if (this.laserElapsed >= this.laserDuration) {
          this.active = false;
        }
      } else {
        this.updateAccelPulse(deltaTime);
        this.x += this.vx;
        this.y += this.vy;
      }
    }
  }

  aimAt(x: number, y: number): void {
    const centerX = this.x + this.width / 2;
    const centerY = this.y + this.height / 2;
    const dx = x - centerX;
    const dy = y - centerY;
    const length = Math.hypot(dx, dy);

    if (length <= 0.0001) {
      return;
    }

    const speed = Math.hypot(this.vx, this.vy) || this._baseSpeed;
    this._moveDirX = dx / length;
    this._moveDirY = dy / length;
    this._baseSpeed = speed;
    this.vx = this._moveDirX * speed;
    this.vy = this._moveDirY * speed;
  }

  startAccelPulse(
    delayMs: number,
    accelMs = 500,
    decelMs = 500,
    peakFactor = 1.5,
  ): void {
    const speed = Math.hypot(this.vx, this.vy) || this._baseSpeed;
    if (speed <= 0.0001) {
      this._accelPulse = null;
      return;
    }

    this._moveDirX = this.vx / speed;
    this._moveDirY = this.vy / speed;
    this._baseSpeed = speed;
    this._accelPulse = {
      delayMs: Math.max(0, Math.floor(delayMs)),
      elapsedMs: 0,
      accelMs: Math.max(0, Math.floor(accelMs)),
      decelMs: Math.max(0, Math.floor(decelMs)),
      baseSpeed: speed,
      peakSpeed: Math.max(speed, speed * Math.max(1, peakFactor)),
    };
  }

  startLaser(
    followTarget: { x: number; y: number; width: number; height: number } | null,
    duration = 1500,
    resetInterval = 400,
    laserWidth = 10,
    options?: { origin?: 'top' | 'bottom'; originY?: number; followX?: boolean; fadeDuration?: number }
  ) {
    this.isLaser = true;
    this.followTarget = followTarget;
    this.laserDuration = duration;
    this.laserResetInterval = resetInterval;
    this.laserElapsed = 0;
    this.width = laserWidth;
    this.height = 0; // 在 update 中计算
    this.vx = 0;
    this.vy = 0;
    this.active = true;
    this.clearHitTargets();

    options = options || {};
    this.laserOrigin = options.origin || 'top';
    this.laserOriginY = typeof options.originY === 'number' ? options.originY : -10;
    this.laserFollowX = options.followX !== undefined ? !!options.followX : true;
    this.laserFadeDuration = typeof options.fadeDuration === 'number' ? options.fadeDuration : Math.max(50, Math.min(300, Math.floor(this.laserDuration * 0.25)));
  }

  startSegmentLaser(
    angleDeg: number,
    speedPxPerSecond: number,
    lengthPx: number,
    thicknessPx = 8,
    lifetimeMs = 2200
  ) {
    const angleRad = (angleDeg * Math.PI) / 180;

    this.isSegmentLaser = true;
    this.isLaser = false;
    this.isTransferring = false;

    this.segmentOriginX = this.x;
    this.segmentOriginY = this.y;
    this.segmentDirX = Math.sin(angleRad);
    this.segmentDirY = Math.cos(angleRad);
    this.segmentPreBounceDirX = this.segmentDirX;
    this.segmentPreBounceDirY = this.segmentDirY;
    this.segmentPostBounceDirX = this.segmentDirX;
    this.segmentPostBounceDirY = this.segmentDirY;
    this.segmentSpeedPxPerSecond = Math.max(1, speedPxPerSecond);
    this.segmentLengthPx = Math.max(1, lengthPx);
    this.segmentTailDelayMs = (this.segmentLengthPx / this.segmentSpeedPxPerSecond) * 1000;
    this.segmentElapsedMs = 0;
    this.segmentLifetimeMs = Math.max(lifetimeMs, this.segmentTailDelayMs + 200);
    this.segmentThicknessPx = Math.max(2, thicknessPx);

    this.segmentHeadX = this.segmentOriginX;
    this.segmentHeadY = this.segmentOriginY;
    this.segmentTailX = this.segmentOriginX;
    this.segmentTailY = this.segmentOriginY;
    this.segmentState = 'normal';
    this.segmentHeadPostBounceDistancePx = 0;
    this.segmentTailPostBounceDistancePx = 0;
    this.segmentBounceEnabled = false;
    this.segmentHasBounced = false;
    this.segmentBounds = null;
    this.segmentBouncePointX = this.segmentOriginX;
    this.segmentBouncePointY = this.segmentOriginY;
    this.segmentHeadDistanceAtBouncePx = 0;
    this.segmentTailDistanceAtBouncePx = 0;

    this.vx = 0;
    this.vy = 0;
    this.width = this.segmentThicknessPx;
    this.height = this.segmentThicknessPx;
    this.active = true;
    this.clearHitTargets();
  }

  startBouncingSegmentLaser(
    angleDeg: number,
    speedPxPerSecond: number,
    lengthPx: number,
    bounds: { minX: number; maxX: number; minY: number; maxY: number },
    thicknessPx = 8,
    lifetimeMs = 2200
  ) {
    this.startSegmentLaser(angleDeg, speedPxPerSecond, lengthPx, thicknessPx, lifetimeMs);
    this.segmentBounceEnabled = true;
    this.segmentBounds = bounds;
  }

  isBeamLike(): boolean {
    return this.isLaser || this.isSegmentLaser;
  }

  getSegmentLaserCollisionData(): { headX: number; headY: number; tailX: number; tailY: number; thicknessPx: number } | null {
    if (!this.isSegmentLaser) {
      return null;
    }

    return {
      headX: this.segmentHeadX,
      headY: this.segmentHeadY,
      tailX: this.segmentTailX,
      tailY: this.segmentTailY,
      thicknessPx: this.segmentThicknessPx,
    };
  }

  getSegmentLaserThreatPolyline(): { points: Array<{ x: number; y: number }>; thicknessPx: number } | null {
    if (!this.isSegmentLaser) {
      return null;
    }

    if (this.segmentBounceEnabled && this.segmentHasBounced) {
      return {
        points: [
          { x: this.segmentTailX, y: this.segmentTailY },
          { x: this.segmentBouncePointX, y: this.segmentBouncePointY },
          { x: this.segmentHeadX, y: this.segmentHeadY },
        ],
        thicknessPx: this.segmentThicknessPx,
      };
    }

    return {
      points: [
        { x: this.segmentTailX, y: this.segmentTailY },
        { x: this.segmentHeadX, y: this.segmentHeadY },
      ],
      thicknessPx: this.segmentThicknessPx,
    };
  }

  configureOutOfBoundsGracePeriod(graceMs: number) {
    this.outOfBoundsGracePeriod = Math.max(0, graceMs);
    this.outOfBoundsSince = null;
  }

  shouldCullOutOfBounds(isOutOfBounds: boolean): boolean {
    if (!isOutOfBounds) {
      this.outOfBoundsSince = null;
      return false;
    }

    if (this.outOfBoundsGracePeriod <= 0) {
      return true;
    }

    const now = Date.now();
    if (this.outOfBoundsSince === null) {
      this.outOfBoundsSince = now;
      return false;
    }

    return now - this.outOfBoundsSince >= this.outOfBoundsGracePeriod;
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

  private updateSegmentLaser(deltaTime: number) {
    this.segmentElapsedMs += deltaTime;
    if (this.segmentElapsedMs >= this.segmentLifetimeMs) {
      this.active = false;
      return;
    }

    const stepDistance = this.segmentSpeedPxPerSecond * (Math.max(0, deltaTime) / 1000);

    // 仅在“未启用反弹”或“无边界”时走直线模式。
    // 已发生反弹后仍需继续执行反弹状态机（wait-tail / wait-gap / post-bounce-follow）。
    if (!this.segmentBounceEnabled || !this.segmentBounds) {
      const headDistance = this.segmentSpeedPxPerSecond * (this.segmentElapsedMs / 1000);
      const tailElapsed = Math.max(0, this.segmentElapsedMs - this.segmentTailDelayMs);
      const tailDistance = this.segmentSpeedPxPerSecond * (tailElapsed / 1000);

      this.segmentHeadX = this.segmentOriginX + this.segmentDirX * headDistance;
      this.segmentHeadY = this.segmentOriginY + this.segmentDirY * headDistance;
      this.segmentTailX = this.segmentOriginX + this.segmentDirX * tailDistance;
      this.segmentTailY = this.segmentOriginY + this.segmentDirY * tailDistance;

      this.updateSegmentBoundsRect();
      return;
    }

    if (this.segmentState === 'normal') {
      const headDistance = this.segmentSpeedPxPerSecond * (this.segmentElapsedMs / 1000);
      const tailElapsed = Math.max(0, this.segmentElapsedMs - this.segmentTailDelayMs);
      const tailDistance = this.segmentSpeedPxPerSecond * (tailElapsed / 1000);

      this.segmentHeadX = this.segmentOriginX + this.segmentDirX * headDistance;
      this.segmentHeadY = this.segmentOriginY + this.segmentDirY * headDistance;
      this.segmentTailX = this.segmentOriginX + this.segmentDirX * tailDistance;
      this.segmentTailY = this.segmentOriginY + this.segmentDirY * tailDistance;

      const bounced = this.tryStartSegmentBounce();
      if (!bounced) {
        this.updateSegmentBoundsRect();
      }
      return;
    }

    if (this.segmentState === 'wait-tail-at-bounce') {
      this.segmentHeadX = this.segmentBouncePointX;
      this.segmentHeadY = this.segmentBouncePointY;
      this.segmentTailDistanceAtBouncePx += stepDistance;

      const tailDistance = Math.min(this.segmentTailDistanceAtBouncePx, this.segmentHeadDistanceAtBouncePx);
      this.segmentTailX = this.segmentOriginX + this.segmentPreBounceDirX * tailDistance;
      this.segmentTailY = this.segmentOriginY + this.segmentPreBounceDirY * tailDistance;

      if (tailDistance >= this.segmentHeadDistanceAtBouncePx - 0.001) {
        this.segmentTailX = this.segmentBouncePointX;
        this.segmentTailY = this.segmentBouncePointY;
        this.segmentState = 'wait-gap-after-bounce';
        this.segmentHeadPostBounceDistancePx = 0;
      }

      this.updateSegmentBoundsRect();
      return;
    }

    if (this.segmentState === 'wait-gap-after-bounce') {
      this.segmentHeadPostBounceDistancePx += stepDistance;
      this.segmentHeadX = this.segmentBouncePointX + this.segmentPostBounceDirX * this.segmentHeadPostBounceDistancePx;
      this.segmentHeadY = this.segmentBouncePointY + this.segmentPostBounceDirY * this.segmentHeadPostBounceDistancePx;
      this.segmentTailX = this.segmentBouncePointX;
      this.segmentTailY = this.segmentBouncePointY;

      if (this.segmentHeadPostBounceDistancePx >= this.segmentLengthPx) {
        this.segmentState = 'post-bounce-follow';
        this.segmentHeadPostBounceDistancePx = this.segmentLengthPx;
        this.segmentTailPostBounceDistancePx = 0;
        this.segmentHeadX = this.segmentBouncePointX + this.segmentPostBounceDirX * this.segmentHeadPostBounceDistancePx;
        this.segmentHeadY = this.segmentBouncePointY + this.segmentPostBounceDirY * this.segmentHeadPostBounceDistancePx;
      }

      this.updateSegmentBoundsRect();
      return;
    }

    this.segmentHeadPostBounceDistancePx += stepDistance;
    this.segmentTailPostBounceDistancePx += stepDistance;
    this.segmentHeadX = this.segmentBouncePointX + this.segmentPostBounceDirX * this.segmentHeadPostBounceDistancePx;
    this.segmentHeadY = this.segmentBouncePointY + this.segmentPostBounceDirY * this.segmentHeadPostBounceDistancePx;
    this.segmentTailX = this.segmentBouncePointX + this.segmentPostBounceDirX * this.segmentTailPostBounceDistancePx;
    this.segmentTailY = this.segmentBouncePointY + this.segmentPostBounceDirY * this.segmentTailPostBounceDistancePx;
    this.updateSegmentBoundsRect();
  }

  private tryStartSegmentBounce(): boolean {
    if (!this.segmentBounds || !this.segmentBounceEnabled || this.segmentHasBounced) {
      return false;
    }

    const bounced = this.resolveSegmentEdgeBounce(this.segmentHeadX, this.segmentHeadY, this.segmentBounds);
    if (!bounced) {
      return false;
    }

    const { x, y, dirX, dirY } = bounced;
    return this.beginSegmentBounce(x, y, dirX, dirY);
  }

  private beginSegmentBounce(
    bouncePointX: number,
    bouncePointY: number,
    postBounceDirX: number,
    postBounceDirY: number
  ): boolean {
    if (!this.segmentBounds || !this.segmentBounceEnabled || this.segmentHasBounced) {
      return false;
    }

    const postLength = Math.hypot(postBounceDirX, postBounceDirY);
    if (postLength <= 0.0001) {
      return false;
    }

    this.segmentHasBounced = true;
    this.segmentState = 'wait-tail-at-bounce';
    this.segmentBouncePointX = bouncePointX;
    this.segmentBouncePointY = bouncePointY;
    this.segmentHeadDistanceAtBouncePx = Math.hypot(
      this.segmentBouncePointX - this.segmentOriginX,
      this.segmentBouncePointY - this.segmentOriginY
    );
    this.segmentTailDistanceAtBouncePx = Math.hypot(
      this.segmentTailX - this.segmentOriginX,
      this.segmentTailY - this.segmentOriginY
    );
    this.segmentPreBounceDirX = this.segmentDirX;
    this.segmentPreBounceDirY = this.segmentDirY;
    this.segmentPostBounceDirX = postBounceDirX / postLength;
    this.segmentPostBounceDirY = postBounceDirY / postLength;
    this.segmentHeadX = this.segmentBouncePointX;
    this.segmentHeadY = this.segmentBouncePointY;
    this.segmentTailX = this.segmentOriginX + this.segmentPreBounceDirX * this.segmentTailDistanceAtBouncePx;
    this.segmentTailY = this.segmentOriginY + this.segmentPreBounceDirY * this.segmentTailDistanceAtBouncePx;
    // 反弹后仍需保留一段额外寿命，避免激光在可见范围内因初始总寿命到点而突然消失。
    this.segmentLifetimeMs = Math.max(
      this.segmentLifetimeMs,
      this.segmentElapsedMs + (this.segmentTailDelayMs * 2) + 300,
    );

    this.updateSegmentBoundsRect();
    return true;
  }

  private resolveSegmentEdgeBounce(
    headX: number,
    headY: number,
    bounds: { minX: number; maxX: number; minY: number; maxY: number }
  ): { x: number; y: number; dirX: number; dirY: number } | null {
    let x = headX;
    let y = headY;
    let dirX = this.segmentDirX;
    let dirY = this.segmentDirY;
    let touched = false;
    // 只允许撞到左右边缘：上下边缘不触发反弹。
    // 侧边边界用可见区域内的 y 值钉住，避免碰撞点落到视口外导致“看起来没有反弹”。
    const clampY = (value: number) => Math.max(bounds.minY, Math.min(bounds.maxY, value));

    if (x < bounds.minX || x > bounds.maxX) {
      x = x < bounds.minX ? bounds.minX : bounds.maxX;
      y = clampY(y);
      dirX *= -1;
      touched = true;
    } else {
      const originX = this.segmentOriginX;
      const originY = this.segmentOriginY;

      const headDx = headX - originX;
      const headDy = headY - originY;
      const headDistance = Math.hypot(headDx, headDy);
      if (headDistance <= 0.0001 || Math.abs(this.segmentDirX) <= 1e-6) {
        return null;
      }

      const dMin = (bounds.minX - originX) / this.segmentDirX;
      if (dMin >= 0 && dMin <= headDistance) {
        x = bounds.minX;
        y = clampY(originY + this.segmentDirY * dMin);
        dirX = -this.segmentDirX;
        dirY = this.segmentDirY;
        touched = true;
      }

      const dMax = (bounds.maxX - originX) / this.segmentDirX;
      if (!touched && dMax >= 0 && dMax <= headDistance) {
        x = bounds.maxX;
        y = clampY(originY + this.segmentDirY * dMax);
        dirX = -this.segmentDirX;
        dirY = this.segmentDirY;
        touched = true;
      }

      if (!touched) {
        return null;
      }
    }

    const length = Math.hypot(dirX, dirY);
    if (length <= 0.0001) {
      return null;
    }

    return {
      x,
      y,
      dirX: dirX / length,
      dirY: dirY / length,
    };
  }

  private updateSegmentBoundsRect() {
    const minX = Math.min(this.segmentHeadX, this.segmentTailX);
    const maxX = Math.max(this.segmentHeadX, this.segmentTailX);
    const minY = Math.min(this.segmentHeadY, this.segmentTailY);
    const maxY = Math.max(this.segmentHeadY, this.segmentTailY);
    const halfThickness = this.segmentThicknessPx / 2;

    this.x = minX - halfThickness;
    this.y = minY - halfThickness;
    this.width = Math.max(this.segmentThicknessPx, maxX - minX + this.segmentThicknessPx);
    this.height = Math.max(this.segmentThicknessPx, maxY - minY + this.segmentThicknessPx);
  }

  getProjectedThreatRect(frame: number, frameDurationMs = 1000 / 60): { x: number; y: number; width: number; height: number } {
    if (this.isSegmentLaser) {
      const elapsedMs = this.segmentElapsedMs + frame * frameDurationMs;
      const headDistance = this.segmentSpeedPxPerSecond * (elapsedMs / 1000);
      const tailElapsed = Math.max(0, elapsedMs - this.segmentTailDelayMs);
      const tailDistance = this.segmentSpeedPxPerSecond * (tailElapsed / 1000);

      const headX = this.segmentOriginX + this.segmentDirX * headDistance;
      const headY = this.segmentOriginY + this.segmentDirY * headDistance;
      const tailX = this.segmentOriginX + this.segmentDirX * tailDistance;
      const tailY = this.segmentOriginY + this.segmentDirY * tailDistance;

      const minX = Math.min(headX, tailX);
      const maxX = Math.max(headX, tailX);
      const minY = Math.min(headY, tailY);
      const maxY = Math.max(headY, tailY);
      const halfThickness = this.segmentThicknessPx / 2;

      return {
        x: minX - halfThickness,
        y: minY - halfThickness,
        width: Math.max(this.segmentThicknessPx, maxX - minX + this.segmentThicknessPx),
        height: Math.max(this.segmentThicknessPx, maxY - minY + this.segmentThicknessPx),
      };
    }

    if (this.isLaser) {
      if (!this.followTarget) {
        return { x: this.x, y: this.y, width: this.width, height: this.height };
      }

      const centerX = this.followTarget.x + this.followTarget.width / 2;
      const centerY = this.followTarget.y + this.followTarget.height / 2;
      const width = this.width;
      const y = this.laserOrigin === 'top'
        ? -10
        : Math.max(0, Math.min(centerY, this.laserOriginY - 4));
      const height = this.laserOrigin === 'top'
        ? Math.max(4, centerY - y)
        : Math.max(4, this.laserOriginY - centerY);

      // 加入速度投影，让AI可以看到激光正在扫描的方向
      const projectedTimeSec = frame * frameDurationMs / 1000;
      const offsetX = this.vx * 60 * projectedTimeSec;
      const offsetY = this.vy * 60 * projectedTimeSec;

      return {
        x: (this.laserFollowX ? centerX - width / 2 : this.x) + offsetX,
        y: y + offsetY,
        width,
        height,
      };
    }

    return {
      x: this.x + this.vx * frame,
      y: this.y + this.vy * frame,
      width: this.width,
      height: this.height,
    };
  }

  isTransferringState(): boolean {
    return this.isTransferring;
  }

  hasHit(target: object): boolean {
    const last = this.hitTimestamps.get(target);
    if (!last) return false;
    // 对于激光，允许在间隔后再次命中；对于其他特殊子弹，视为一次性命中（cooldown 无限）
    const cooldown = this.isLaser ? this.laserResetInterval : Number.POSITIVE_INFINITY;
    return (Date.now() - last) < cooldown;
  }

  markHit(target: object): void {
    this.hitTimestamps.set(target, Date.now());
  }

  render(ctx: CanvasRenderingContext2D) {
    ctx.save();
    if (this.isTransferring) {
      const pulse = 0.45 + 0.25 * Math.sin(Date.now() / 60);
      ctx.globalAlpha = pulse;
      ctx.fillStyle = 'rgba(255, 209, 102, 0.85)';
      this.drawDiamond(ctx, this.x, this.y, this.width * 2, this.height * 1.8, true);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
      ctx.lineWidth = 1;
      this.drawDiamond(ctx, this.x - this.width * 0.1, this.y - this.height * 0.05, this.width * 2.2, this.height * 2.0, false);
      ctx.restore();
      return;
    }

    // 圆形光球渲染分支（用于在对方屏幕生成的光球）
    if (this.isCircular) {
      const cx = this.x + this.width / 2;
      const cy = this.y + this.height / 2;
      const radius = Math.max(2, Math.min(200, Math.max(this.width, this.height) / 2));
      const palette = this.getPalette();

      // 轻微脉动效果
      const pulse = 0.85 + 0.12 * Math.sin(Date.now() / 100);
      ctx.globalAlpha = pulse;

      ctx.shadowColor = palette.glow;
      ctx.shadowBlur = Math.max(6, radius * 0.8);

      const grad = ctx.createRadialGradient(cx, cy, Math.max(1, radius * 0.15), cx, cy, radius);
      grad.addColorStop(0, palette.core);
      grad.addColorStop(0.6, palette.edge);
      grad.addColorStop(1, 'rgba(255,255,255,0.02)');

      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = palette.edge;
      ctx.lineWidth = Math.max(1, Math.floor(radius * 0.12));
      ctx.stroke();

      ctx.restore();
      return;
    }
    // 预警效果：在对方屏幕底部闪烁提示，不造成伤害
    if (this.isWarning) {
      if (typeof this.warningAlpha === 'number') {
        ctx.globalAlpha = this.warningAlpha;
      } else {
        const pulse = 0.45 + 0.35 * Math.sin(Date.now() / 120);
        ctx.globalAlpha = pulse;
      }
      ctx.fillStyle = this.side === 'left' ? 'rgba(89, 240, 255, 0.95)' : 'rgba(255, 111, 142, 0.95)';
      // 绘制一个简单的底部矩形作为预警标记
      ctx.fillRect(this.x, this.y - this.height, this.width, this.height);
      ctx.restore();
      return;
    }

    if (this.isSegmentLaser) {
      const colorSide: PlayerSide = this.ownerSide ?? (this.category === 'player1' ? 'left' : this.category === 'player2' ? 'right' : this.side);
      const strokeColor = colorSide === 'left' ? 'rgba(89, 240, 255, 0.92)' : 'rgba(255, 111, 142, 0.92)';
      const shadowColor = colorSide === 'left' ? 'rgba(89, 240, 255, 0.45)' : 'rgba(255, 111, 142, 0.45)';
      const headFill = colorSide === 'left' ? 'rgba(89, 240, 255, 0.95)' : 'rgba(255, 111, 142, 0.95)';

      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = this.segmentThicknessPx;
      ctx.lineCap = 'round';
      ctx.shadowColor = shadowColor;
      ctx.shadowBlur = 10;

      // 如果存在 segmentBounds，则在绘制前裁剪到该矩形，防止越过半屏边界绘制
      let clipped = false;
      if (this.segmentBounds) {
        const sb = this.segmentBounds;
        const half = this.segmentThicknessPx / 2;
        ctx.save();
        ctx.beginPath();
        ctx.rect(sb.minX - half, sb.minY - half, (sb.maxX - sb.minX) + this.segmentThicknessPx, (sb.maxY - sb.minY) + this.segmentThicknessPx);
        ctx.clip();
        clipped = true;
      }

      ctx.beginPath();
      ctx.moveTo(this.segmentTailX, this.segmentTailY);
      ctx.lineTo(this.segmentHeadX, this.segmentHeadY);
      ctx.stroke();

      ctx.fillStyle = headFill;
      ctx.beginPath();
      ctx.arc(this.segmentHeadX, this.segmentHeadY, Math.max(2, this.segmentThicknessPx * 0.33), 0, Math.PI * 2);
      ctx.fill();

      if (clipped) {
        ctx.restore();
      }

      ctx.restore();
      return;
    }

    if (this.isLaser) {
      // 计算淡出 alpha
      const fadeStart = Math.max(0, this.laserDuration - this.laserFadeDuration);
      let alpha = 1;
      if (this.laserElapsed >= fadeStart) {
        alpha = Math.max(0, (this.laserDuration - this.laserElapsed) / this.laserFadeDuration);
      }
      ctx.globalAlpha = alpha;

      const colorSide: PlayerSide = this.ownerSide ?? (this.category === 'player1' ? 'left' : this.category === 'player2' ? 'right' : this.side);
      const midColor = colorSide === 'left' ? 'rgba(89, 240, 255, 0.88)' : 'rgba(255, 111, 142, 0.88)';
      const gradient = ctx.createLinearGradient(this.x, this.y, this.x + this.width, this.y);
      gradient.addColorStop(0, 'rgba(255, 255, 255, 0.04)');
      gradient.addColorStop(0.5, midColor);
      gradient.addColorStop(1, 'rgba(255, 255, 255, 0.04)');
      ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
      ctx.fillRect(this.x - this.width * 1.4, this.y, this.width * 3.8, this.height);
      ctx.fillStyle = gradient;
      ctx.fillRect(this.x, this.y, this.width, this.height);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
      ctx.lineWidth = 1;
      ctx.strokeRect(this.x, this.y, this.width, this.height);
      ctx.restore();
      return;
    }

    const palette = this.getPalette();
    ctx.fillStyle = palette.core;
    ctx.strokeStyle = palette.edge;
    ctx.lineWidth = 1;
    ctx.shadowColor = palette.glow;
    ctx.shadowBlur = 8;

    // 根据速度方向旋转子弹，使其朝向运动方向
    const cx = this.x + this.width / 2;
    const cy = this.y + this.height / 2;
    const vx = this.vx || 0;
    const vy = this.vy || 0;
    const speed = Math.hypot(vx, vy);

    if (speed > 0.0001) {
      const angle = Math.atan2(vy, vx);
      // 使高度方向对齐运动方向：旋转角度为 angle + 90°
      ctx.translate(cx, cy);
      ctx.rotate(angle + Math.PI / 2);
      this.drawProjectile(ctx);
    } else {
      ctx.translate(cx, cy);
      this.drawProjectile(ctx);
    }

    ctx.restore();
  }

  startTransfer(
    targetX: number,
    targetY: number,
    duration: number,
    _targetCategory: BulletCategory,
    targetSide: PlayerSide,
    aimTarget?: { x: number; y: number },
    options?: { easing?: 'linear' | 'easeOutQuad' }
  ) {
    this.isTransferring = true;
    this.transferDuration = duration;
    this.targetX = targetX;
    this.targetY = targetY;
    this.startX = this.x;
    this.startY = this.y;
    this.transferEasing = options?.easing ?? 'linear';
    // 保持原始类别（弹幕），不要把它变成玩家子弹，仍然移动到目标 side
    this.side = targetSide;
    this.active = true;
    // 从力场/外部消除状态重置标记
    this.destroyedByExpandingField = false;
    this.postTransferAimTarget = aimTarget ?? null;
    // 清除以往的命中记录，确保转移后可以对新目标造成伤害
    this.clearHitTargets();
  }

  private syncMotionStateFromVelocity() {
    const speed = Math.hypot(this.vx, this.vy);
    this._baseSpeed = speed;
    if (speed > 0.0001) {
      this._moveDirX = this.vx / speed;
      this._moveDirY = this.vy / speed;
      return;
    }

    this._moveDirX = 0;
    this._moveDirY = 1;
  }

  private updateAccelPulse(deltaTime: number) {
    const pulse = this._accelPulse;
    if (!pulse) {
      return;
    }

    pulse.elapsedMs += Math.max(0, deltaTime);
    if (pulse.elapsedMs < pulse.delayMs) {
      this.applyMovementSpeed(pulse.baseSpeed);
      return;
    }

    const activeMs = pulse.elapsedMs - pulse.delayMs;
    let currentSpeed = pulse.baseSpeed;

    if (pulse.accelMs <= 0 && pulse.decelMs <= 0) {
      currentSpeed = pulse.baseSpeed;
      this._accelPulse = null;
    } else if (activeMs < pulse.accelMs) {
      const progress = pulse.accelMs <= 0 ? 1 : activeMs / pulse.accelMs;
      currentSpeed = pulse.baseSpeed + (pulse.peakSpeed - pulse.baseSpeed) * progress;
    } else if (activeMs < pulse.accelMs + pulse.decelMs) {
      const progress = pulse.decelMs <= 0 ? 1 : (activeMs - pulse.accelMs) / pulse.decelMs;
      currentSpeed = pulse.peakSpeed - (pulse.peakSpeed - pulse.baseSpeed) * progress;
    } else {
      currentSpeed = pulse.baseSpeed;
      this._accelPulse = null;
    }

    this.applyMovementSpeed(currentSpeed);
  }

  private applyMovementSpeed(speed: number) {
    this.vx = this._moveDirX * speed;
    this.vy = this._moveDirY * speed;
  }

  clearHitTargets(): void {
    // 重新初始化 WeakMap
    // @ts-ignore 私有字段重置
    this.hitTimestamps = new WeakMap<object, number>();
  }

  // 外部触发：开始一个时基的预警淡入。
  startWarningRamp(durationMs: number, targetAlpha = 0.5) {
    this.isWarning = true;
    this.warningDurationMs = Math.max(0, Math.floor(durationMs));
    this.warningElapsedMs = 0;
    this.warningTargetAlpha = Math.max(0, Math.min(1, targetAlpha));
    this.warningAlpha = 0;
  }

  private getPalette() {
    if (this.isTransferring) {
      return { core: 'rgba(255, 209, 102, 0.9)', edge: 'rgba(255, 255, 255, 0.5)', glow: 'rgba(255, 209, 102, 0.3)' };
    }

    if (this.bulletType === 'special') {
      const visualSide: PlayerSide = this.ownerSide ?? this.side;
      return visualSide === 'left'
        ? { core: 'rgba(89, 240, 255, 0.95)', edge: 'rgba(255, 255, 255, 0.5)', glow: 'rgba(89, 240, 255, 0.32)' }
        : { core: 'rgba(255, 111, 142, 0.95)', edge: 'rgba(255, 255, 255, 0.5)', glow: 'rgba(255, 111, 142, 0.32)' };
    }

    if (this.category === 'barrage') {
      return this.canBeDestroyed
        ? { core: 'rgba(255, 255, 255, 0.94)', edge: 'rgba(255, 255, 255, 0.62)', glow: 'rgba(255, 255, 255, 0.3)' }
        : { core: 'rgba(245, 245, 245, 0.94)', edge: 'rgba(255, 255, 255, 0.56)', glow: 'rgba(255, 255, 255, 0.26)' };
    }

    return this.category === 'player1'
      ? { core: 'rgba(89, 240, 255, 0.9)', edge: 'rgba(255, 255, 255, 0.34)', glow: 'rgba(89, 240, 255, 0.24)' }
      : { core: 'rgba(255, 111, 142, 0.9)', edge: 'rgba(255, 255, 255, 0.34)', glow: 'rgba(255, 111, 142, 0.24)' };
  }

  private drawProjectile(ctx: CanvasRenderingContext2D) {
    const bodyWidth = Math.max(2, this.width);
    const bodyHeight = Math.max(6, this.height);
    const halfW = bodyWidth / 2;
    const halfH = bodyHeight / 2;

    ctx.beginPath();
    ctx.moveTo(0, -halfH);
    ctx.lineTo(halfW * 0.78, -halfH * 0.2);
    ctx.lineTo(halfW * 0.44, halfH * 0.48);
    ctx.lineTo(-halfW * 0.44, halfH * 0.48);
    ctx.lineTo(-halfW * 0.78, -halfH * 0.2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.beginPath();
    ctx.moveTo(0, -halfH * 0.72);
    ctx.lineTo(halfW * 0.18, 0);
    ctx.lineTo(0, halfH * 0.44);
    ctx.lineTo(-halfW * 0.18, 0);
    ctx.closePath();
    ctx.fill();
  }

  private drawDiamond(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, fill: boolean) {
    const halfW = width / 2;
    const halfH = height / 2;
    ctx.beginPath();
    ctx.moveTo(x + halfW, y);
    ctx.lineTo(x + width, y + halfH);
    ctx.lineTo(x + halfW, y + height);
    ctx.lineTo(x, y + halfH);
    ctx.closePath();
    if (fill) {
      ctx.fill();
    } else {
      ctx.stroke();
    }
  }
}