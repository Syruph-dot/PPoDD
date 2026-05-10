import { Bullet } from '../Bullet';
import { AircraftProfile, SkillContext } from './types';

const triggerLaserBoss = (side: 'left' | 'right', intensity: 2 | 3 | 4, game: SkillContext['game']) => {
  const targetSide = side === 'left' ? 'right' : 'left';
  // pass the caster side so boss lasers can be colored to the caster
  game.triggerBoss(targetSide, 'laser', undefined, side);
  const boss = game.getBoss();
  const skillBoss = boss as unknown as { setSkillIntensity?: (level: 2 | 3 | 4) => void } | null;
  if (skillBoss?.setSkillIntensity) {
    skillBoss.setSkillIntensity(intensity);
  }
};

export const laserAircraftProfile: AircraftProfile = {
  type: 'laser',
  getPalette(side) {
    return side === 'left'
      ? { stroke: '#9cff6e', glow: 'rgba(156, 255, 110, 0.34)', fill: 'rgba(10, 18, 30, 0.96)' }
      : { stroke: '#ffd166', glow: 'rgba(255, 209, 102, 0.34)', fill: 'rgba(10, 18, 30, 0.96)' };
  },
  useNormalAttack({ player, game, aimDirectionDeg, addBullet }) {
    const category = player.getSide() === 'left' ? 'player1' : 'player2';
    const viewport = game.getSideViewport(player.getSide());
    const laser = new Bullet(
      player.x + player.width / 2,
      player.y + player.height / 2,
      0,
      0,
      category,
      'special',
      false,
      7,
      7,
      2,
      player.getSide()
    );

    // 玩家发射的激光缩短至原长度的 40%
    laser.startBouncingSegmentLaser(
      aimDirectionDeg,
      900,
      Math.round(180 * 0.4),
      {
        minX: viewport.x,
        maxX: viewport.x + viewport.width,
        minY: viewport.y,
        maxY: viewport.y + viewport.height,
      },
      7,
      1200
    );

    addBullet(laser);
  },
  useLevel1Skill({ player, addBullet }) {
    const category = player.getSide() === 'left' ? 'player1' : 'player2';
    const laser = new Bullet(
      player.x + player.width / 2,
      player.y,
      0,
      0,
      category,
      'special',
      false,
      10,
      10,
      10,
      player.getSide()
    );
    if ((laser as { startLaser?: (owner: unknown, durationMs: number, cooldownMs: number, damage: number) => void }).startLaser) {
      (laser as { startLaser: (owner: unknown, durationMs: number, cooldownMs: number, damage: number) => void }).startLaser(player, 1500, 400, 10);
    }
    addBullet(laser);
  },
  handleLevel2Skill({ player, game, skillTokenId }) {
    // 生成 3 个目标，每个间隔 0.25s：从自机发射光球到目标底部（先快后慢），光球到达后逐渐显示 1s 预警，随后激活 0.5s 激光
    // 同时触发扩散力场（所有机体都应触发）
    if (typeof skillTokenId === 'number') {
      game.attachSkillField(player.getSide(), player.getSide(), 0.3, 1000, skillTokenId);
    } else {
      game.triggerExpandingField(player.getSide(), player.getSide(), 0.3, 1000);
    }

    const targetSide = player.getSide() === 'left' ? 'right' : 'left';
    const viewport = game.getSideViewport(targetSide);
    const thickness = 12;
    const category = player.getSide() === 'left' ? 'player1' : 'player2';

    const count = 3;
    const perSpawnDelay = 250; // ms
    const transferDuration = 700; // 光球移动耗时（ms）
    const preWarningDuration = 1000; // ms
    const activeDuration = 500; // ms 激光持续时间
    const resetInterval = 200; // ms 重复命中间隔
    const damage = 12;

    for (let i = 0; i < count; i++) {
      const spawnDelay = i * perSpawnDelay;
      game.runWithLifecycle(() => {
        const chosenX = viewport.x + Math.random() * viewport.width;

        // 预警占位（初始不可见，等待光球到达后淡入）
        const warning = new Bullet(
          chosenX - Math.floor(thickness / 2),
          viewport.y + viewport.height,
          0,
          0,
          category,
          'special',
          false,
          thickness,
          viewport.height,
          0,
          targetSide
        );
        warning.isWarning = false;
        warning.warningAlpha = 0;

        // 光球，从自机发射到目标底部
        const orb = new Bullet(
          player.x + player.width / 2,
          player.y + player.height / 2,
          0,
          0,
          category,
          'special',
          false,
          8,
          8,
          0,
          player.getSide()
        );

        // 把子弹加入世界并绑定到 lifecycle（若有）
        if (typeof skillTokenId === 'number') {
          game.addSkillBullet(warning, skillTokenId);
          game.addSkillBullet(orb, skillTokenId);
        } else {
          game.addBullet(warning);
          game.addBullet(orb);
        }

        // 光球传送到目标位置（先快后慢）
        orb.startTransfer(
          chosenX - Math.floor(thickness / 2),
          viewport.y + viewport.height,
          transferDuration,
          category,
          targetSide,
          undefined,
          { easing: 'easeOutQuad' }
        );

        // 在光球到达时开始淡入预警，并在淡入完成后生成激光
        if (typeof skillTokenId === 'number') {
          game.scheduleSkillLifecycleCallback(skillTokenId, () => {
            warning.startWarningRamp(preWarningDuration, 0.5);
          }, transferDuration);

          game.scheduleSkillLifecycleCallback(skillTokenId, () => {
            warning.active = false;
            const beam = new Bullet(
              chosenX - Math.floor(thickness / 2),
              viewport.y + viewport.height,
              0,
              0,
              'barrage',
              'special',
              false,
              thickness,
              viewport.height,
              damage,
              targetSide
            );
            beam.ownerSide = player.getSide();
            const followTarget = { x: chosenX, y: 0, width: 0, height: 0 };
            beam.startLaser(followTarget, activeDuration, resetInterval, thickness, { origin: 'bottom', originY: viewport.y + viewport.height, followX: true });
            game.addSkillBullet(beam, skillTokenId);
          }, transferDuration + preWarningDuration);
        } else {
          game.runWithLifecycle(() => {
            warning.startWarningRamp(preWarningDuration, 0.5);
          }, transferDuration);

          game.runWithLifecycle(() => {
            warning.active = false;
            const beam = new Bullet(
              chosenX - Math.floor(thickness / 2),
              viewport.y + viewport.height,
              0,
              0,
              'barrage',
              'special',
              false,
              thickness,
              viewport.height,
              damage,
              targetSide
            );
            beam.ownerSide = player.getSide();
            const followTarget = { x: chosenX, y: 0, width: 0, height: 0 };
            beam.startLaser(followTarget, activeDuration, resetInterval, thickness, { origin: 'bottom', originY: viewport.y + viewport.height, followX: true });
            game.addBullet(beam);
          }, transferDuration + preWarningDuration);
        }

      }, spawnDelay);
    }

    return false;
  },
  handleLevel3Skill({ player, game, skillTokenId }) {
    // 生成 4 个目标，每个间隔 0.25s：从自机发射光球到目标底部（先快后慢），光球到达后逐渐显示 1s 预警，随后激活 1.5s 激光
    // 同时触发扩散力场（所有机体都应触发）
    if (typeof skillTokenId === 'number') {
      game.attachSkillField(player.getSide(), player.getSide(), 0.5, 1000, skillTokenId);
    } else {
      game.triggerExpandingField(player.getSide(), player.getSide(), 0.5, 1000);
    }

    const targetSide = player.getSide() === 'left' ? 'right' : 'left';
    const viewport = game.getSideViewport(targetSide);
    const thickness = 14;
    const category = player.getSide() === 'left' ? 'player1' : 'player2';

    const count = 4;
    const perSpawnDelay = 250; // ms
    const transferDuration = 700; // 光球移动耗时（ms）
    const preWarningDuration = 1000; // ms
    const activeDuration = 1500; // ms 激光持续时间
    const resetInterval = 200; // ms 重复命中间隔
    const damage = 14;

    for (let i = 0; i < count; i++) {
      const spawnDelay = i * perSpawnDelay;
      game.runWithLifecycle(() => {
        const chosenX = viewport.x + Math.random() * viewport.width;

        const warning = new Bullet(
          chosenX - Math.floor(thickness / 2),
          viewport.y + viewport.height,
          0,
          0,
          category,
          'special',
          false,
          thickness,
          viewport.height,
          0,
          targetSide
        );
        warning.isWarning = false;
        warning.warningAlpha = 0;

        const orb = new Bullet(
          player.x + player.width / 2,
          player.y + player.height / 2,
          0,
          0,
          category,
          'special',
          false,
          8,
          8,
          0,
          player.getSide()
        );

        if (typeof skillTokenId === 'number') {
          game.addSkillBullet(warning, skillTokenId);
          game.addSkillBullet(orb, skillTokenId);
        } else {
          game.addBullet(warning);
          game.addBullet(orb);
        }

        orb.startTransfer(
          chosenX - Math.floor(thickness / 2),
          viewport.y + viewport.height,
          transferDuration,
          category,
          targetSide,
          undefined,
          { easing: 'easeOutQuad' }
        );

        if (typeof skillTokenId === 'number') {
          game.scheduleSkillLifecycleCallback(skillTokenId, () => {
            warning.startWarningRamp(preWarningDuration, 0.5);
          }, transferDuration);

          game.scheduleSkillLifecycleCallback(skillTokenId, () => {
            warning.active = false;
            const beam = new Bullet(
              chosenX - Math.floor(thickness / 2),
              viewport.y + viewport.height,
              0,
              0,
              'barrage',
              'special',
              false,
              thickness,
              viewport.height,
              damage,
              targetSide
            );
            beam.ownerSide = player.getSide();
            const followTarget = { x: chosenX, y: 0, width: 0, height: 0 };
            beam.startLaser(followTarget, activeDuration, resetInterval, thickness, { origin: 'bottom', originY: viewport.y + viewport.height, followX: true });
            game.addSkillBullet(beam, skillTokenId);
          }, transferDuration + preWarningDuration);
        } else {
          game.runWithLifecycle(() => {
            warning.startWarningRamp(preWarningDuration, 0.5);
          }, transferDuration);

          game.runWithLifecycle(() => {
            warning.active = false;
            const beam = new Bullet(
              chosenX - Math.floor(thickness / 2),
              viewport.y + viewport.height,
              0,
              0,
              'barrage',
              'special',
              false,
              thickness,
              viewport.height,
              damage,
              targetSide
            );
            beam.ownerSide = player.getSide();
            const followTarget = { x: chosenX, y: 0, width: 0, height: 0 };
            beam.startLaser(followTarget, activeDuration, resetInterval, thickness, { origin: 'bottom', originY: viewport.y + viewport.height, followX: true });
            game.addBullet(beam);
          }, transferDuration + preWarningDuration);
        }

      }, spawnDelay);
    }

    return false;
  },
  handleLevel4Skill({ player, game, skillTokenId }) {
    // 触发扩散力场（保持与其他机体一致）
    if (typeof skillTokenId === 'number') {
      game.attachSkillField(player.getSide(), player.getSide(), 1, 1000, skillTokenId);
    } else {
      game.triggerExpandingField(player.getSide(), player.getSide(), 1, 1000);
    }

    triggerLaserBoss(player.getSide(), 4, game);
    // Allow base/advanced attack to proceed after boss trigger
    return false;
  },
};
