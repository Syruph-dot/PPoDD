import { Bullet } from '../Bullet';
import { AircraftProfile } from './types';
import { emitPatternBullets } from '../bullets/patternEmitter';
import { BulletPattern } from '../bullets/types';

const scatterNormalPattern: BulletPattern = {
  kind: 'chain',
  count: 2,
  baseSpeed: 11,
  distribution: 'lerp',
  intervalMs: 80,
  child: {
    kind: 'fan',
    count: 3,
    angleRangeDeg: 10,
    baseSpeed: 11,
    shape: 'circle',
  },
};

export const scatterAircraftProfile: AircraftProfile = {
  type: 'scatter',
  getPalette(side) {
    return side === 'left'
      ? { stroke: '#59f0ff', glow: 'rgba(89, 240, 255, 0.34)', fill: 'rgba(10, 18, 30, 0.96)' }
      : { stroke: '#ff6f8e', glow: 'rgba(255, 111, 142, 0.34)', fill: 'rgba(10, 18, 30, 0.96)' };
  },
  useNormalAttack({ player, game, aimDirectionDeg, addBullet }) {
    const category = player.getSide() === 'left' ? 'player1' : 'player2';

    emitPatternBullets(
      scatterNormalPattern,
      {
        originX: player.x + player.width / 2,
        originY: player.y,
        directionDeg: aimDirectionDeg,
        side: player.getSide(),
        category,
        bulletType: 'normal',
        canBeDestroyed: false,
        width: 4,
        height: 10,
        damage: 0.6,
      },
      (bullet, delayMs) => {
        if (delayMs <= 0) {
          addBullet(bullet);
          return;
        }

        game.runWithLifecycle(() => addBullet(bullet), delayMs);
      }
    );
  },
  useLevel1Skill({ player, addBullet }) {
    const category = player.getSide() === 'left' ? 'player1' : 'player2';
    for (let i = -1; i <= 1; i++) {
      addBullet(new Bullet(
        player.x + player.width / 2,
        player.y,
        i * 2,
        -10,
        category,
        'special',
        false,
        50,
        50,
        10,
        player.getSide()
      ));
    }
  },
  handleLevel3Skill({ player, game, skillTokenId, addBullet }) {
    const targetSide = player.getSide() === 'left' ? 'right' : 'left';
    // trigger field on caster side (same as default player behavior)
    game.triggerExpandingField(player.getSide(), player.getSide(), 0.5);
    const targetX = targetSide === 'left'
      ? game.getScreenWidth() * 0.25
      : game.getScreenWidth() * 0.75;

    for (let i = 0; i < 20; i++) {
      game.runWithLifecycle(() => {
        const bx = targetX + (Math.random() - 0.5) * 200;
        const b = new Bullet(
          bx,
          0,
          (Math.random() - 0.5) * 2,
          3 + Math.random() * 2,
          'barrage',
          'special',
          false,
          4,
          10,
          10,
          targetSide
        );

        // 把最终尺寸调整为当前大小的约 120%，并标记为圆形光球
        const diameter = Math.max(b.width, b.height) * 1.2;
        b.width = diameter;
        b.height = diameter;
        (b as any).isCircular = true;

        if (typeof skillTokenId === 'number') {
          game.addSkillBullet(b, skillTokenId);
        } else {
          addBullet(b);
        }
      }, i * 250);
    }

    return true;
  },
};
