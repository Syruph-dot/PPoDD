import { Game } from '../core/Game';
import { Boss } from '../core/Boss';
import { Bullet } from '../core/Bullet';
import { Enemy } from '../core/Enemy';
import { Player } from '../core/Player';
import { Difficulty, Observation, PlayerSide } from '../entities/types';
import { SkillId, SkillScheduler } from './SkillScheduler';
import { MAX_BULLET_SLOTS, MAX_ENEMY_SLOTS } from './policy/featureLayout';
import type { PolicyDecision, PolicyDecisionProvider } from './policy/types';

interface Vector2 {
  x: number;
  y: number;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface HitboxCircle {
  x: number;
  y: number;
  radius: number;
}

interface PolylineThreatGeometry {
  points: Vector2[];
  thicknessPx: number;
}

interface BulletSpatialIndex {
  buckets: Map<string, Bullet[]>;
  cellSize: number;
  queryPadding: number;
}

interface AIProfile {
  decisionInterval: number;
  lookAheadFrames: number;
  laneSamples: number;
  threatPadding: number;
  threatWeight: number;
  attackWeight: number;
  moveWeight: number;
  edgeWeight: number;
  centerBiasWeight: number;
  edgeDwellWeight: number;
  bulletApproachWeight: number;
  beamThreatWeight: number;
  warningThreatWeight: number;
  randomJitter: number;
  deadZone: number;
  tapHoldMs: number;
  postActionCooldownMs: number;
  releaseWindows: [number, number, number, number, number];
  pressureThresholds: [number, number, number, number];
  pressureThreatPenalty: number;
  panicThreatThreshold: number;
  lowHealthRatio: number;
  enemyLaneWidth: number;
  bossPressureBonus: number;
  opponentLowHealthBonus: number;
  bombThreatThreshold: number;
  bombNearbyThreshold: number;
  bossBombHealthThreshold: number;
  allowUnlimitedTopSkill: boolean;
  opportunisticBurstThreatMax: number;
  enemyBodyThreatWeight: number;
  enemyBodyLookAheadFrames: number;
  enemyBodySpeedEstimate: number;
  idleProbeFireIntervalMs: number;
  minNonBombSkillIntervalMs: number;
  bulletThreatInflate: number;
}

interface MovementPlan {
  target: Vector2;
  threat: number;
  opportunity: number;
  pressureScore: number;
  score: number;
}

interface AIContext {
  currentCenter: Vector2;
  currentThreat: number;
  nearbyBulletCount: number;
  dangerousBulletIndex: BulletSpatialIndex;
  enemies: Enemy[];
  boss: Boss | null;
  opponentHealthRatio: number;
  selfHealthRatio: number;
  maxUsefulLevel: number;
}

type FireDecision = 'keepGun' | 'stopGun';
type FireBlockedReason = 'none' | 'skill' | 'charging' | 'postActionCooldown' | 'noTarget';

// ---------------------------------------------------------------------------
// Match phase state machine — inspired by the 東方夢時空 (PoDD) design:
//   - opening:  aggressive offense, bombs held in reserve
//   - midgame:  balanced survival + scoring (standard profile)
//   - endgame:  conservative resource management, controlled burst
//   - survival: emergency defense — use all resources to stay alive
// Phase transitions are driven by elapsed match time AND live health ratios,
// mirroring how PoDD adjusts CPU behaviour per stage/difficulty/health band.
// ---------------------------------------------------------------------------
type MatchPhase = 'opening' | 'midgame' | 'endgame' | 'survival';

// Multipliers applied on top of the base difficulty profile each phase.
// Values > 1 amplify the underlying parameter; < 1 dampen it.
interface PhaseAdjustment {
  attackWeightScale: number;
  threatWeightScale: number;
  bombThreatScale: number;       // scales bombThreatThreshold (lower = bomb sooner)
  bombNearbyScale: number;       // scales bombNearbyThreshold (lower = bomb on fewer bullets)
  panicThreatScale: number;      // scales panicThreatThreshold
  randomJitterScale: number;
  opponentLowHealthBonusScale: number;
}

const PHASE_ADJUSTMENTS: Record<MatchPhase, PhaseAdjustment> = {
  opening: {
    attackWeightScale: 1.25,
    threatWeightScale: 0.85,
    bombThreatScale: 1.25,       // hold bombs longer in opening
    bombNearbyScale: 1.35,
    panicThreatScale: 1.10,
    randomJitterScale: 1.20,
    opponentLowHealthBonusScale: 0.80,
  },
  midgame: {
    attackWeightScale: 1.00,
    threatWeightScale: 1.00,
    bombThreatScale: 1.00,
    bombNearbyScale: 1.00,
    panicThreatScale: 1.00,
    randomJitterScale: 1.00,
    opponentLowHealthBonusScale: 1.00,
  },
  endgame: {
    attackWeightScale: 0.85,
    threatWeightScale: 1.20,
    bombThreatScale: 0.85,       // use bombs more freely in endgame
    bombNearbyScale: 0.85,
    panicThreatScale: 0.90,
    randomJitterScale: 0.70,
    opponentLowHealthBonusScale: 1.35,
  },
  survival: {
    attackWeightScale: 0.60,
    threatWeightScale: 1.60,
    bombThreatScale: 0.65,       // bomb very aggressively in survival
    bombNearbyScale: 0.65,
    panicThreatScale: 0.75,
    randomJitterScale: 0.30,
    opponentLowHealthBonusScale: 1.10,
  },
};

// Phase timing thresholds (milliseconds of match elapsed time).
const PHASE_OPENING_END_MS = 18_000;   //  0–18 s
const PHASE_MIDGAME_END_MS = 90_000;   // 18–90 s
// Beyond 90 s = endgame; survival is health-driven and can trigger at any time.

export class AIController {
  private readonly game: Game;
  private readonly player: Player;
  private readonly side: PlayerSide;
  private readonly profile: AIProfile;
  private readonly skillScheduler = new SkillScheduler();

  private decisionAccumulator = 0;
  private edgeDwellMs = 0;
  private charging = false;
  private chargeHoldMs = 0;
  private chargingTargetLevel = 0;
  private postActionCooldownMs = 0;
  public lastSkillMask: boolean[] = [];
  public lastSkillRequested: SkillId = 'none';
  public lastSkillExecuted: SkillId = 'none';
  public lastFireDecision: FireDecision = 'stopGun';
  public lastFireBlockedReason: FireBlockedReason = 'none';
  public lastFireExecuted: 'none' | 'shoot' = 'none';
  private readonly policyProvider: PolicyDecisionProvider | null;
  private latestPolicyDecision: PolicyDecision | null = null;
  private policyDecisionPending = false;
  private policyStallMs = 0;
  private lastPolicyCenter: Vector2 | null = null;
  private lastNormalFireAtMs = 0;
  private lastNonBombSkillAtMs = 0;

  // Dodge state triggered by immediate bullet spawn notifications
  private dodgeTarget: Vector2 | null = null;
  private dodgeRemainingMs = 0;

  // Match phase state machine
  private matchElapsedMs = 0;
  private currentPhase: MatchPhase = 'opening';

  // Backward-compatible UI hook used by Game HUD.
  getChargeIntent(): { isCharging: boolean; progress: number; skill: string } {
    const chargingSkill = this.chargingTargetLevel >= 1 && this.player.isChargingNow();
    const requiredHold = chargingSkill
      ? this.profile.releaseWindows[Math.max(1, Math.min(4, this.chargingTargetLevel))]
      : 1;
    const progress = chargingSkill
      ? this.clamp(this.chargeHoldMs / Math.max(1, requiredHold), 0, 1)
      : 0;
    return {
      isCharging: chargingSkill,
      progress,
      skill: chargingSkill ? (`skill${this.chargingTargetLevel}`) : this.lastSkillRequested,
    };
  }

  /** Returns the current match phase (for telemetry / HUD). */
  getMatchPhase(): MatchPhase {
    return this.currentPhase;
  }

  constructor(game: Game, player: Player, side: PlayerSide, difficulty: Difficulty, policyProvider: PolicyDecisionProvider | null = null) {
    this.game = game;
    this.player = player;
    this.side = side;
    this.profile = this.getProfile(difficulty);
    this.policyProvider = policyProvider;
  }

  update(deltaTime: number) {
    this.decisionAccumulator += deltaTime;
    this.matchElapsedMs += deltaTime;
    this.updateEdgeDwell(deltaTime);

    if (this.charging && !this.player.isChargingNow()) {
      const currentCharge = this.player.getChargeSystem().getCurrentCharge();
      if (this.chargeHoldMs > 0 || currentCharge > 0) {
        this.resetChargeChain();
      }
    }

    if (this.postActionCooldownMs > 0) {
      this.postActionCooldownMs = Math.max(0, this.postActionCooldownMs - deltaTime);
    }

    if (this.charging) {
      this.chargeHoldMs += deltaTime;
    }

    // Handle any active dodge window (set by onBulletAdded)
    if (this.dodgeRemainingMs > 0) {
      this.dodgeRemainingMs = Math.max(0, this.dodgeRemainingMs - deltaTime);
      this.applyDodgeMovement();
    }

    while (this.decisionAccumulator >= this.profile.decisionInterval) {
      this.decisionAccumulator -= this.profile.decisionInterval;
      this.makeDecision();
    }
  }

  private makeDecision() {
    // Recompute the match phase and get the adjusted profile for this decision.
    this.currentPhase = this.computeMatchPhase();
    const effectiveProfile = this.computePhaseProfile();

    const context = this.buildContext();
    const movementPlan = this.chooseMovementPlanWithProfile(context, effectiveProfile);
    const observation = this.buildObservation(context);
    const policyDecision: PolicyDecision | null = this.resolvePolicyDecision(observation);

    // build current skill availability mask for trainer / policy
    if (this.player && typeof this.player.getAvailableSkills === 'function') {
      const avail = this.player.getAvailableSkills();
      this.lastSkillMask = [avail.skill1, avail.skill2, avail.skill3, avail.skill4, avail.bomb];
      // console.debug('[AI] skillMask', this.lastSkillMask);
    }

    let skillRequested: SkillId = 'none';
    let skillExecuted: SkillId = 'none';
    let fireState: { decision: FireDecision; blockedReason: FireBlockedReason } = { decision: 'stopGun', blockedReason: 'none' };
    let fireExecuted: 'none' | 'shoot' = 'none';
    const fireTargetAvailable = this.hasShootableTarget(context);
    const desiredFireFromPolicy = policyDecision ? this.policyFireToDecision(policyDecision.fire) : 'keepGun';

    if (policyDecision) {
      this.applyPolicyMovement(policyDecision.move);
      this.updatePolicyStallState(context.currentCenter, policyDecision.move);

      // Guard against policy collapse to prolonged "stay" decisions.
      // When the ship has been effectively stationary for a while under live pressure,
      // temporarily fall back to rule-based movement to keep the agent responsive.
      if (this.shouldFallbackToRuleMovement(context, policyDecision.move)) {
        this.applyMovementPlan(movementPlan);
      }

      skillRequested = this.skillLabelToId(policyDecision.skill);
      skillExecuted = this.executeRequestedSkill(skillRequested);

      this.lastSkillRequested = skillRequested;
      this.lastSkillExecuted = skillExecuted;
      if (skillExecuted === 'skill1' || skillExecuted === 'skill2' || skillExecuted === 'skill3' || skillExecuted === 'skill4') {
        this.lastNonBombSkillAtMs = Date.now();
      }
      if (skillExecuted !== 'none') {
        this.postActionCooldownMs = Math.max(this.postActionCooldownMs, this.profile.postActionCooldownMs);
      }

      fireState = this.selectFireState(context, skillExecuted, desiredFireFromPolicy);
      this.lastFireDecision = fireState.decision;
      this.lastFireBlockedReason = fireState.blockedReason;

      if (fireState.decision === 'keepGun' && fireState.blockedReason === 'none') {
        fireExecuted = this.skillScheduler.triggerSkill('shoot', this.player, this.game) as 'none' | 'shoot';
        if (fireExecuted === 'shoot') {
          this.lastNormalFireAtMs = Date.now();
        }
      }
      this.lastFireExecuted = fireExecuted;
    } else {
      skillRequested = this.selectSkillRequestWithProfile(context, movementPlan, effectiveProfile);
      skillExecuted = this.executeRequestedSkill(skillRequested);

      this.lastSkillRequested = skillRequested;
      this.lastSkillExecuted = skillExecuted;
      if (skillExecuted === 'skill1' || skillExecuted === 'skill2' || skillExecuted === 'skill3' || skillExecuted === 'skill4') {
        this.lastNonBombSkillAtMs = Date.now();
      }
      if (skillExecuted !== 'none') {
        this.postActionCooldownMs = Math.max(this.postActionCooldownMs, this.profile.postActionCooldownMs);
      }

      fireState = this.selectFireState(context, skillExecuted, 'keepGun');
      this.lastFireDecision = fireState.decision;
      this.lastFireBlockedReason = fireState.blockedReason;

      if (fireState.decision === 'keepGun' && fireState.blockedReason === 'none') {
        fireExecuted = this.skillScheduler.triggerSkill('shoot', this.player, this.game) as 'none' | 'shoot';
        if (fireExecuted === 'shoot') {
          this.lastNormalFireAtMs = Date.now();
        }
      }
      this.lastFireExecuted = fireExecuted;
      this.applyMovementPlan(movementPlan);
    }

    // Record a lightweight training event for this decision tick
    try {
      const tickMetadata = this.game.getTickMetadata(this.side);
      this.game.pushTrainingEvent({
        ts: Date.now(),
        side: this.side,
        ...tickMetadata,
        matchPhase: this.currentPhase,
        playerCenter: observation.self.pos,
        movementTarget: movementPlan.target,
        movementScore: movementPlan.score,
        threat: context.currentThreat,
        nearbyBulletCount: context.nearbyBulletCount,
        enemies: observation.enemies,
        skillMask: this.lastSkillMask,
        skillRequested,
        skillExecuted,
        fireTargetAvailable,
        fireDecision: fireState.decision,
        fireBlockedReason: fireState.blockedReason,
        fireExecuted,
        observation,
        policyDecision: policyDecision ? {
          move: policyDecision.move,
          fire: policyDecision.fire,
          skill: policyDecision.skill,
          confidence: policyDecision.confidence,
        } : null,
      });
    } catch (e) {
      // swallow to avoid impacting game loop
    }
  }

  private resolvePolicyDecision(observation: Observation): PolicyDecision | null {
    if (!this.policyProvider) {
      return null;
    }

    if (this.policyDecisionPending) {
      return this.latestPolicyDecision;
    }

    try {
      const decisionOrPromise = this.policyProvider.decide(observation);
      if (decisionOrPromise && typeof (decisionOrPromise as Promise<PolicyDecision>).then === 'function') {
        this.policyDecisionPending = true;
        (decisionOrPromise as Promise<PolicyDecision>)
          .then((decision) => {
            this.latestPolicyDecision = decision;
          })
          .catch((error) => {
            console.warn('[AIController] Async policy inference failed, falling back to rule AI.', error);
          })
          .finally(() => {
            this.policyDecisionPending = false;
          });
        return this.latestPolicyDecision;
      }

      this.latestPolicyDecision = decisionOrPromise as PolicyDecision;
      return this.latestPolicyDecision;
    } catch (error) {
      console.warn('[AIController] Policy provider failed, falling back to rule AI.', error);
      return this.latestPolicyDecision;
    }
  }

  private buildObservation(context: AIContext): Observation {
    const selfCenter = context.currentCenter;
    const selfChargeSystem = this.player.getChargeSystem();
    const opponentPlayer = this.game.getPlayer(this.getOpponentSide());
    const opponentChargeSystem = opponentPlayer?.getChargeSystem();

    const playerVelocity = {
      vx: ((this.player.movingRight ? 1 : 0) - (this.player.movingLeft ? 1 : 0)) * this.player.speed,
      vy: ((this.player.movingDown ? 1 : 0) - (this.player.movingUp ? 1 : 0)) * this.player.speed,
    };

    const opponentVelocity = opponentPlayer
      ? {
          vx: ((opponentPlayer.movingRight ? 1 : 0) - (opponentPlayer.movingLeft ? 1 : 0)) * opponentPlayer.speed,
          vy: ((opponentPlayer.movingDown ? 1 : 0) - (opponentPlayer.movingUp ? 1 : 0)) * opponentPlayer.speed,
        }
      : { vx: 0, vy: 0 };

    const enemySlots = this.game
      .getEnemies(this.side)
      .filter((enemy) => enemy.active)
      .slice()
      .sort((leftEnemy, rightEnemy) => this.distance(
        { x: leftEnemy.x + leftEnemy.width / 2, y: leftEnemy.y + leftEnemy.height / 2 },
        selfCenter,
      ) - this.distance(
        { x: rightEnemy.x + rightEnemy.width / 2, y: rightEnemy.y + rightEnemy.height / 2 },
        selfCenter,
      ))
      .slice(0, MAX_ENEMY_SLOTS)
      .map((enemy) => ({
        pos: { x: enemy.x + enemy.width / 2, y: enemy.y + enemy.height / 2 },
        width: enemy.width,
        height: enemy.height,
        health: enemy.health,
        maxHealth: enemy.maxHealth,
      }));

    const allBullets = [...this.game.getBullets('left'), ...this.game.getBullets('right')]
      .filter((bullet) => bullet.active)
      .slice()
      .sort((leftBullet, rightBullet) => this.distance(this.getBulletCenter(leftBullet), selfCenter) - this.distance(this.getBulletCenter(rightBullet), selfCenter))
      .slice(0, MAX_BULLET_SLOTS)
      .map((bullet) => ({
        pos: { x: bullet.x + bullet.width / 2, y: bullet.y + bullet.height / 2 },
        vel: { vx: bullet.vx ?? 0, vy: bullet.vy ?? 0 },
        width: bullet.width,
        height: bullet.height,
        damage: bullet.damage,
        category: bullet.category,
        bulletType: bullet.bulletType,
        side: bullet.side,
        isBeamLike: typeof bullet.isBeamLike === 'function' ? bullet.isBeamLike() : false,
        isWarning: !!bullet.isWarning,
        canBeDestroyed: !!bullet.canBeDestroyed,
        isCircular: !!bullet.isCircular,
      }));

    const boss = context.boss;
    const bossState = boss
      ? {
          pos: { x: boss.x + boss.width / 2, y: boss.y + boss.height / 2 },
          width: boss.width,
          height: boss.height,
          health: boss.health,
          maxHealth: boss.maxHealth,
          active: boss.active,
          canTakeDamage: boss.canTakeDamage(),
          side: boss.side,
        }
      : null;

    return {
      self: {
        pos: selfCenter,
        vel: playerVelocity,
        health: this.player.health,
        bombs: this.player.bombs,
        isCharging: this.charging,
        currentCharge: selfChargeSystem.getCurrentCharge(),
        chargeMax: selfChargeSystem.getChargeMax(),
        side: this.side,
      },
      opponent: opponentPlayer
        ? {
            pos: { x: opponentPlayer.x + opponentPlayer.width / 2, y: opponentPlayer.y + opponentPlayer.height / 2 },
            vel: opponentVelocity,
            health: opponentPlayer.health,
            bombs: opponentPlayer.bombs,
            isCharging: !!opponentChargeSystem && opponentChargeSystem.getCurrentCharge() > 0,
            currentCharge: opponentChargeSystem?.getCurrentCharge() ?? 0,
            chargeMax: opponentChargeSystem?.getChargeMax() ?? 0,
            side: this.getOpponentSide(),
          }
        : null,
      enemies: enemySlots,
      bullets: allBullets,
      boss: bossState,
      arena: {
        currentThreat: context.currentThreat,
        nearbyBulletCount: context.nearbyBulletCount,
        decisionIntervalMs: this.profile.decisionInterval,
      },
      screen: {
        width: this.game.getScreenWidth(),
        height: this.game.getScreenHeight(),
        margin: this.game.getMargin(),
      },
      tick_ms: Date.now(),
      decision_interval_ms: this.profile.decisionInterval,
    };
  }

  private applyPolicyMovement(move: PolicyDecision['move']) {
    if (this.dodgeRemainingMs > 0 && this.dodgeTarget) {
      return;
    }

    const movementFlags = {
      left: false,
      right: false,
      up: false,
      down: false,
    };

    switch (move) {
      case 'left':
        movementFlags.left = true;
        break;
      case 'right':
        movementFlags.right = true;
        break;
      case 'up':
        movementFlags.up = true;
        break;
      case 'down':
        movementFlags.down = true;
        break;
      case 'up-left':
        movementFlags.left = true;
        movementFlags.up = true;
        break;
      case 'up-right':
        movementFlags.right = true;
        movementFlags.up = true;
        break;
      case 'down-left':
        movementFlags.left = true;
        movementFlags.down = true;
        break;
      case 'down-right':
        movementFlags.right = true;
        movementFlags.down = true;
        break;
      case 'stay':
      default:
        break;
    }

    this.player.movingLeft = movementFlags.left;
    this.player.movingRight = movementFlags.right;
    this.player.movingUp = movementFlags.up;
    this.player.movingDown = movementFlags.down;
  }

  private updatePolicyStallState(center: Vector2, move: PolicyDecision['move']) {
    if (this.lastPolicyCenter) {
      const movedDistance = this.distance(center, this.lastPolicyCenter);
      const effectivelyStationary = movedDistance <= Math.max(0.5, this.profile.deadZone * 0.2);
      if (effectivelyStationary && move === 'stay') {
        this.policyStallMs += this.profile.decisionInterval;
      } else {
        this.policyStallMs = 0;
      }
    }

    this.lastPolicyCenter = { x: center.x, y: center.y };
  }

  private shouldFallbackToRuleMovement(context: AIContext, move: PolicyDecision['move']): boolean {
    if (move !== 'stay') {
      return false;
    }

    const stallThresholdMs = Math.max(600, this.profile.decisionInterval * 5);
    if (this.policyStallMs < stallThresholdMs) {
      return false;
    }

    const hasPressure = context.currentThreat >= Math.max(0.3, this.profile.panicThreatThreshold * 0.2)
      || context.nearbyBulletCount > 0
      || context.enemies.length > 0
      || !!context.boss;

    if (!hasPressure) {
      return false;
    }

    this.policyStallMs = 0;
    return true;
  }

  private policyFireToDecision(fire: PolicyDecision['fire']): FireDecision {
    return fire === 'stopGun' ? 'stopGun' : 'keepGun';
  }

  private skillLabelToId(skill: PolicyDecision['skill']): SkillId {
    switch (skill) {
      case 'skill1':
      case 'skill2':
      case 'skill3':
      case 'skill4':
      case 'bomb':
        return skill;
      case 'none':
      default:
        return 'none';
    }
  }

  private normalizeChargeSkillRequest(skillRequested: SkillId): SkillId {
    const avail = this.player.getAvailableSkills();

    switch (skillRequested) {
      case 'skill4':
        if (avail.skill4) return 'skill4';
        if (this.charging && this.chargingTargetLevel >= 1) return `skill${this.chargingTargetLevel}` as SkillId;
        if (avail.skill3) return 'skill3';
        if (avail.skill2) return 'skill2';
        if (avail.skill1) return 'skill1';
        return 'none';
      case 'skill3':
        if (avail.skill3) return 'skill3';
        if (this.charging && this.chargingTargetLevel >= 1) return `skill${this.chargingTargetLevel}` as SkillId;
        if (avail.skill2) return 'skill2';
        if (avail.skill1) return 'skill1';
        return 'none';
      case 'skill2':
        if (avail.skill2) return 'skill2';
        if (this.charging && this.chargingTargetLevel >= 1) return `skill${this.chargingTargetLevel}` as SkillId;
        if (avail.skill1) return 'skill1';
        return 'none';
      case 'skill1':
        if (avail.skill1) return 'skill1';
        if (this.charging && this.chargingTargetLevel >= 1) return `skill${this.chargingTargetLevel}` as SkillId;
        return 'none';
      default:
        return skillRequested;
    }
  }

  private selectFireState(
    context: AIContext,
    skillExecuted: SkillId,
    desiredFire: FireDecision,
  ): { decision: FireDecision; blockedReason: FireBlockedReason } {
    if (desiredFire === 'stopGun') {
      return { decision: 'stopGun', blockedReason: 'none' };
    }

    if (this.charging) {
      return { decision: 'stopGun', blockedReason: 'charging' };
    }

    if (this.postActionCooldownMs > 0) {
      return { decision: 'stopGun', blockedReason: 'postActionCooldown' };
    }

    // Do not block normal attack just because a skill was requested.
    // Only the skill that actually executes this tick should suppress fire.
    if (skillExecuted !== 'none') {
      return { decision: 'stopGun', blockedReason: 'skill' };
    }

    if (this.hasShootableTarget(context)) {
      return { decision: 'keepGun', blockedReason: 'none' };
    }

    const now = Date.now();
    if (now - this.lastNormalFireAtMs >= this.profile.idleProbeFireIntervalMs) {
      return { decision: 'keepGun', blockedReason: 'none' };
    }

    return { decision: 'stopGun', blockedReason: 'noTarget' };
  }

  private hasShootableTarget(context: AIContext): boolean {
    const bossOnMySide = Boolean(context.boss && context.boss.side === this.side && context.boss.canTakeDamage());
    return context.enemies.length > 0 || bossOnMySide;
  }

  private hasCloseFrontEnemy(context: AIContext): boolean {
    try {
      const center = context.currentCenter;
      const laneWidth = this.profile.enemyLaneWidth || 98;
      const horizThreshold = Math.max(this.player.width, laneWidth * 0.6);
      const vertThreshold = 400;
      for (const e of context.enemies) {
        const enemyCenterX = e.x + (e.width || 0) / 2;
        const enemyCenterY = e.y + (e.height || 0) / 2;
        const dx = Math.abs(enemyCenterX - center.x);
        const dy = center.y - enemyCenterY; // positive when enemy is above the player (in front)
        if (dy > 0 && dy <= vertThreshold && dx <= horizThreshold) {
          return true;
        }
      }
    } catch (e) {
      // swallow
    }
    return false;
  }

  // Called by Game when a new bullet is spawned. Allows the AI to react
  // immediately to beam/laser spawns (skill2/skill3) rather than waiting
  // for the next decision tick.
  public onBulletAdded(bullet: Bullet) {
    try {
      if (!bullet || typeof bullet !== 'object') return;

      // We only care about barrage/beam bullets that target this side (they
      // are the ones that can hurt the player).
      if (bullet.side !== this.side) return;

      const isBeamLike = typeof (bullet as any).isBeamLike === 'function' && (bullet as any).isBeamLike();
      const isBarrage = bullet.category === 'barrage';
      if (!isBeamLike && !isBarrage) return;

      const center = this.getPlayerCenter();
      const hitbox = this.getPlayerHitbox();
      const threatHitbox = this.inflateHitbox(hitbox, this.profile.threatPadding + 6);

      const threatPolyline = this.getSegmentLaserThreatPolyline(bullet);
      const rect = threatPolyline
        ? this.getPolylineBounds(threatPolyline.points, threatPolyline.thicknessPx)
        : typeof (bullet as any).getProjectedThreatRect === 'function'
          ? (bullet as any).getProjectedThreatRect(0)
          : { x: bullet.x, y: bullet.y, width: bullet.width, height: bullet.height };

      // If the beam doesn't intersect the expanded hitbox region and is far away, skip
      if (this.getRectDistanceToHitbox(rect, threatHitbox) > Math.max(rect.width, rect.height) * 1.5) {
        return;
      }

      // Choose a lateral dodge target outside beam rect if possible
      const bounds = this.getSideBounds();
      const leftSafe = this.clamp(rect.x - this.player.width - 12, bounds.minX, bounds.maxX);
      const rightSafe = this.clamp(rect.x + rect.width + this.player.width + 12, bounds.minX, bounds.maxX);
      const currX = center.x;
      const leftDist = Math.abs(currX - leftSafe);
      const rightDist = Math.abs(currX - rightSafe);

      if (Math.abs(leftSafe - rightSafe) < 2) {
        // Beam covers whole horizontal area — try vertical dodge
        const upY = this.clamp(center.y - 80, bounds.minY, bounds.maxY);
        const downY = this.clamp(center.y + 80, bounds.minY, bounds.maxY);
        const upDist = Math.abs(center.y - upY);
        const downDist = Math.abs(center.y - downY);
        const chosenY = upDist < downDist ? upY : downY;
        this.dodgeTarget = { x: currX, y: chosenY };
      } else {
        const chosenX = leftDist < rightDist ? leftSafe : rightSafe;
        this.dodgeTarget = { x: chosenX, y: center.y };
      }

      // Set dodge duration heuristically based on beam height (ms)
      const baseMs = 420;
      const extra = Math.min(800, Math.floor((rect.height || 0) / 2));
      this.dodgeRemainingMs = Math.max(this.dodgeRemainingMs, baseMs + extra);

      // Apply movement immediately so AI reacts before next decision tick
      this.applyDodgeMovement();
    } catch (e) {
      // swallow
    }
  }

  private applyDodgeMovement() {
    if (!this.dodgeTarget) return;
    const center = this.getPlayerCenter();
    const dx = this.dodgeTarget.x - center.x;
    const dy = this.dodgeTarget.y - center.y;

    this.player.movingLeft = dx < -this.profile.deadZone;
    this.player.movingRight = dx > this.profile.deadZone;
    this.player.movingUp = dy < -this.profile.deadZone;
    this.player.movingDown = dy > this.profile.deadZone;

    if (Math.abs(dx) <= this.profile.deadZone) {
      this.player.movingLeft = false;
      this.player.movingRight = false;
    }
    if (Math.abs(dy) <= this.profile.deadZone) {
      this.player.movingUp = false;
      this.player.movingDown = false;
    }
  }

  private selectSkillRequestWithProfile(context: AIContext, plan: MovementPlan, prof: AIProfile): SkillId {
    const avail = this.player.getAvailableSkills();
    const boss = context.boss;
    const panicThreat = Math.max(context.currentThreat, plan.threat);

    if (avail.bomb) {
      const bossOnMySide = boss?.side === this.side;
      const bossOnOpponentSide = Boolean(boss && boss.side !== this.side);
      const criticalHealth = context.selfHealthRatio <= (prof.lowHealthRatio * 0.8);
      const denseBullets = context.nearbyBulletCount >= prof.bombNearbyThreshold;
      const highThreat = panicThreat >= (prof.bombThreatThreshold * 1.15);
      const extremeThreat = panicThreat >= (prof.bombThreatThreshold * 1.4);
      const cornerTrap = this.edgeDwellMs >= 900;

      if (cornerTrap && denseBullets && panicThreat >= (prof.bombThreatThreshold * 0.9)) {
        return 'bomb';
      }

      if (bossOnMySide && (criticalHealth || (extremeThreat && denseBullets))) {
        return 'bomb';
      }

      if (bossOnOpponentSide && boss && boss.canTakeDamage()) {
        const bossHealthRatio = boss.health / Math.max(1, boss.maxHealth);
        if (bossHealthRatio <= Math.max(0.12, prof.bossBombHealthThreshold * 0.7) && panicThreat <= prof.panicThreatThreshold * 0.9) {
          return 'bomb';
        }
      }

      if (criticalHealth && denseBullets && highThreat) {
        return 'bomb';
      }
    }

    const maxUsefulLevel = context.maxUsefulLevel;
    const desiredLevel = this.getDesiredSkillLevelWithProfile(context, plan, maxUsefulLevel, prof);

    // If there's a close enemy in front, prefer normal attack over charge skills (1..3).
    // Allow top-level releases (level 4) and bombs as usual.
    if (this.hasCloseFrontEnemy(context)) {
      if (desiredLevel >= 4 && avail.skill4) return 'skill4';
      return 'none';
    }

    if (desiredLevel >= 4 && avail.skill4) return 'skill4';
    if (desiredLevel >= 3 && avail.skill3) return 'skill3';
    if (desiredLevel >= 2 && avail.skill2) return 'skill2';

    // Avoid spamming level-1 by requiring an actual attack window.
    if (desiredLevel >= 1 && avail.skill1 && plan.opportunity >= 0.95 && plan.threat <= prof.opportunisticBurstThreatMax) {
      return 'skill1';
    }

    return 'none';
  }

  private executeRequestedSkill(skillRequested: SkillId): SkillId {
    if (skillRequested === 'bomb') {
      this.resetChargeChain();
      return this.skillScheduler.triggerSkill('bomb', this.player, this.game);
    }

    skillRequested = this.normalizeChargeSkillRequest(skillRequested);

    if (
      skillRequested !== 'none'
      && !this.charging
      && this.lastNonBombSkillAtMs > 0
      && (Date.now() - this.lastNonBombSkillAtMs) < this.profile.minNonBombSkillIntervalMs
    ) {
      return 'none';
    }

    if (skillRequested === 'skill1') {
      return this.runChargeChainForLevel(1);
    }

    if (skillRequested === 'skill2' || skillRequested === 'skill3' || skillRequested === 'skill4') {
      const targetLevel = Number(skillRequested.replace('skill', ''));
      return this.runChargeChainForLevel(targetLevel as 1 | 2 | 3 | 4);
    }

    // If no request while charging, continue existing chain until release.
    if (this.charging && this.chargingTargetLevel >= 1) {
      return this.runChargeChainForLevel(this.chargingTargetLevel as 1 | 2 | 3 | 4);
    }

    return 'none';
  }

  private runChargeChainForLevel(targetLevel: 1 | 2 | 3 | 4): SkillId {
    if (!this.charging || this.chargingTargetLevel !== targetLevel) {
      if (this.postActionCooldownMs > 0) {
        return 'none';
      }
      this.player.startCharging(this.game);
      this.charging = true;
      this.chargeHoldMs = 0;
      this.chargingTargetLevel = targetLevel;
      return 'none';
    }

    const chargeLevel = this.player.getChargeSystem().getLevel();
    const requiredHoldMs = this.profile.releaseWindows[Math.max(1, Math.min(4, targetLevel))];
    if (chargeLevel >= targetLevel && this.chargeHoldMs >= requiredHoldMs) {
      const executed = this.player.releaseCharge(this.game) as SkillId;
      this.resetChargeChain();
      return executed;
    }

    return 'none';
  }

  private resetChargeChain() {
    this.charging = false;
    this.chargeHoldMs = 0;
    this.chargingTargetLevel = 0;
  }

  private buildContext(): AIContext {
    const currentHitbox = this.getPlayerHitbox();
    const currentCenter = { x: currentHitbox.x, y: currentHitbox.y };
    const enemies = this.game
      .getEnemies(this.side)
      .filter((enemy) => enemy.active);
    const boss = this.game.getBoss();

    const dangerousBullets = this.getDangerousBullets();
    const dangerousBulletIndex = this.buildDangerousBulletIndex(dangerousBullets);
    const currentThreatBullets = this.queryDangerousBulletsForCenter(dangerousBulletIndex, currentCenter, currentHitbox.radius);
    const currentThreat = this.computeThreatScore(currentCenter, currentThreatBullets, enemies);
    const nearbyBulletCount = currentThreatBullets.filter((bullet) => this.getRectDistanceToHitbox({
      x: bullet.x,
      y: bullet.y,
      width: bullet.width,
      height: bullet.height,
    }, currentHitbox) < 120).length;

    const opponentSide = this.getOpponentSide();
    const opponentPlayer = this.game.getPlayer(opponentSide);

    const chargeSystem = this.player.getChargeSystem();
    const maxUsefulLevel = this.getMaxUsefulLevel(chargeSystem.getChargeMax());

    return {
      currentCenter,
      currentThreat,
      nearbyBulletCount,
      dangerousBulletIndex,
      enemies,
      boss,
      opponentHealthRatio: opponentPlayer ? opponentPlayer.health / 100 : 1,
      selfHealthRatio: this.player.health / 100,
      maxUsefulLevel,
    };
  }

  private chooseMovementPlanWithProfile(context: AIContext, prof: AIProfile): MovementPlan {
    const bulletIndex = context.dangerousBulletIndex;
    const screenHeight = this.game.getScreenHeight();
    const sideBounds = this.getSideBounds();
    const currentCenter = context.currentCenter;
    const playerHitboxRadius = this.getPlayerHitbox().radius;
    const laneCenterX = (sideBounds.minX + sideBounds.maxX) / 2;
    const halfLaneWidth = Math.max(1, (sideBounds.maxX - sideBounds.minX) / 2);
    const calmFactor = this.clamp(1 - (context.currentThreat / Math.max(0.001, prof.panicThreatThreshold)), 0, 1);

    const targetY = this.clamp(
      screenHeight * (0.66 + Math.min(context.currentThreat, 5) * 0.03),
      sideBounds.minY,
      sideBounds.maxY,
    );

    const candidateXs = this.buildCandidateXs(currentCenter.x, context.enemies, sideBounds);
    const candidateYs = this.buildCandidateYs(currentCenter.y, targetY, sideBounds, context.currentThreat);

    let bestPlan: MovementPlan | null = null;

    for (const candidateX of candidateXs) {
      for (const candidateY of candidateYs) {
        const candidate = { x: candidateX, y: candidateY };
        const bullets = this.queryDangerousBulletsForCenter(bulletIndex, candidate, playerHitboxRadius);
        const threat = this.computeThreatScore(candidate, bullets, context.enemies);
        const opportunity = this.computeOpportunityScore(candidateX, context.enemies, context.boss, context.opponentHealthRatio);
        const distanceCost = this.distance(currentCenter, candidate);
        const edgePenalty = this.computeEdgePenalty(candidateX, sideBounds);
        const yPenalty = Math.abs(candidateY - targetY) / 48;
        const centerDistance = Math.abs(candidateX - laneCenterX) / halfLaneWidth;
        const edgeDwellScale = 1 + Math.min(2, this.edgeDwellMs / 1000) * prof.edgeDwellWeight;
        const centerBias = centerDistance * prof.centerBiasWeight * (0.35 + calmFactor) * (1 + Math.min(1.5, this.edgeDwellMs / 1200));

        const score = (threat * prof.threatWeight)
          - (opportunity * prof.attackWeight)
          + (distanceCost * prof.moveWeight)
          + (edgePenalty * prof.edgeWeight * edgeDwellScale)
          + centerBias
          + (yPenalty * 0.25)
          + (Math.random() * prof.randomJitter);

        const pressureScore = opportunity
          - (threat * prof.pressureThreatPenalty)
          - (distanceCost / 250);

        if (!bestPlan || score < bestPlan.score) {
          bestPlan = {
            target: candidate,
            threat,
            opportunity,
            pressureScore,
            score,
          };
        }
      }
    }

    return bestPlan ?? {
      target: currentCenter,
      threat: context.currentThreat,
      opportunity: 0,
      pressureScore: 0,
      score: Number.POSITIVE_INFINITY,
    };
  }

  private applyMovementPlan(plan: MovementPlan) {
    // If a dodge is currently active, keep dodge movement flags set and
    // avoid overriding them with the regular movement planner.
    if (this.dodgeRemainingMs > 0 && this.dodgeTarget) {
      return;
    }

    const center = this.getPlayerCenter();
    const dx = plan.target.x - center.x;
    const dy = plan.target.y - center.y;

    this.player.movingLeft = dx < -this.profile.deadZone;
    this.player.movingRight = dx > this.profile.deadZone;
    this.player.movingUp = dy < -this.profile.deadZone;
    this.player.movingDown = dy > this.profile.deadZone;

    if (Math.abs(dx) <= this.profile.deadZone) {
      this.player.movingLeft = false;
      this.player.movingRight = false;
    }

    if (Math.abs(dy) <= this.profile.deadZone) {
      this.player.movingUp = false;
      this.player.movingDown = false;
    }
  }

  private buildCandidateXs(currentX: number, enemies: Enemy[], bounds: { minX: number; maxX: number }): number[] {
    const width = bounds.maxX - bounds.minX;
    const positions = new Set<number>();

    positions.add(this.clamp(currentX, bounds.minX, bounds.maxX));
    positions.add(this.clamp(bounds.minX + width * 0.18, bounds.minX, bounds.maxX));
    positions.add(this.clamp(bounds.minX + width * 0.5, bounds.minX, bounds.maxX));
    positions.add(this.clamp(bounds.minX + width * 0.82, bounds.minX, bounds.maxX));

    const clusterX = this.computeEnemyClusterX(enemies, bounds);
    positions.add(clusterX);

    for (let index = 0; index < this.profile.laneSamples; index++) {
      const lane = bounds.minX + width * ((index + 0.5) / this.profile.laneSamples);
      positions.add(this.clamp(lane, bounds.minX, bounds.maxX));
    }

    return Array.from(positions);
  }

  private buildCandidateYs(currentY: number, targetY: number, bounds: { minY: number; maxY: number }, threat: number): number[] {
    const panicY = this.clamp(bounds.maxY, bounds.minY, bounds.maxY);
    const safeY = this.clamp(bounds.minY + (bounds.maxY - bounds.minY) * 0.88, bounds.minY, bounds.maxY);
    const attackY = this.clamp(bounds.minY + (bounds.maxY - bounds.minY) * 0.62, bounds.minY, bounds.maxY);
    const extraOffset = this.clamp(targetY + Math.min(24, threat * 5), bounds.minY, bounds.maxY);

    return Array.from(new Set([
      this.clamp(currentY, bounds.minY, bounds.maxY),
      targetY,
      attackY,
      safeY,
      panicY,
      extraOffset,
    ]));
  }

  private computeEnemyClusterX(enemies: Enemy[], bounds: { minX: number; maxX: number }): number {
    if (enemies.length === 0) {
      return (bounds.minX + bounds.maxX) / 2;
    }

    let weightedX = 0;
    let totalWeight = 0;

    for (const enemy of enemies) {
      const centerX = enemy.x + enemy.width / 2;
      const weight = 1 + Math.max(0, enemy.y) / this.game.getScreenHeight();
      weightedX += centerX * weight;
      totalWeight += weight;
    }

    if (totalWeight <= 0) {
      return (bounds.minX + bounds.maxX) / 2;
    }

    return this.clamp(weightedX / totalWeight, bounds.minX, bounds.maxX);
  }

  private computeOpportunityScore(candidateX: number, enemies: Enemy[], boss: Boss | null, opponentHealthRatio: number): number {
    let opportunity = 0;
    const laneWidth = this.profile.enemyLaneWidth;

    for (const enemy of enemies) {
      const centerX = enemy.x + enemy.width / 2;
      const distance = Math.abs(centerX - candidateX);

      if (distance > laneWidth) {
        continue;
      }

      const laneScore = 1 - (distance / laneWidth);
      const heightWeight = 1 + Math.max(0, enemy.y) / (this.game.getScreenHeight() * 0.8);
      opportunity += laneScore * heightWeight;
    }

    if (boss && boss.side !== this.side) {
      opportunity += this.profile.bossPressureBonus;
    }

    if (opponentHealthRatio <= 0.35) {
      opportunity += this.profile.opponentLowHealthBonus;
    }

    return opportunity;
  }

  private computeThreatScore(center: Vector2, bullets: Bullet[], enemies: Enemy[]): number {
    const playerHitbox = this.inflateHitbox({
      x: center.x,
      y: center.y,
      radius: this.getPlayerHitbox().radius,
    }, this.profile.threatPadding);
    let threat = 0;

    for (const bullet of bullets) {
      threat += this.computeBulletThreat(bullet, playerHitbox);
    }

    threat += this.computeEnemyBodyThreat(center, enemies);

    return threat;
  }

  private computeEnemyBodyThreat(center: Vector2, enemies: Enemy[]): number {
    const lookAhead = this.profile.enemyBodyLookAheadFrames;
    const playerRect = this.getInflatedRect(center, this.profile.threatPadding + 10);
    let threat = 0;

    for (const enemy of enemies) {
      let localThreat = 0;

      for (let frame = 0; frame <= lookAhead; frame++) {
        const projectedY = enemy.y + this.profile.enemyBodySpeedEstimate * frame;
        const enemyRect = {
          x: enemy.x,
          y: projectedY,
          width: enemy.width,
          height: enemy.height,
        };

        if (this.rectsOverlap(enemyRect, playerRect)) {
          localThreat = Math.max(localThreat, 1.4 + ((lookAhead - frame + 1) / lookAhead));
          break;
        }

        const horizontalGap = Math.max(
          playerRect.x - (enemyRect.x + enemyRect.width),
          enemyRect.x - (playerRect.x + playerRect.width),
          0,
        );
        const verticalGap = Math.max(
          playerRect.y - (enemyRect.y + enemyRect.height),
          enemyRect.y - (playerRect.y + playerRect.height),
          0,
        );

        const distance = Math.hypot(horizontalGap, verticalGap);
        if (distance < 90) {
          localThreat = Math.max(localThreat, (90 - distance) / 90 * 0.85);
        }
      }

      threat += localThreat * this.profile.enemyBodyThreatWeight;
    }

    return threat;
  }

  private computeBulletThreat(bullet: Bullet, hitbox: HitboxCircle): number {
    const lookAheadFrames = this.profile.lookAheadFrames;
    const bulletCenter = this.getBulletCenter(bullet);
    const toHitX = hitbox.x - bulletCenter.x;
    const toHitY = hitbox.y - bulletCenter.y;
    const distanceToHit = Math.max(1, Math.hypot(toHitX, toHitY));
    const bulletSpeed = Math.max(1, Math.hypot(bullet.vx, bullet.vy));
    const approachAlignment = Math.max(0, (toHitX * bullet.vx + toHitY * bullet.vy) / (distanceToHit * bulletSpeed));
    const motionMultiplier = 1 + (approachAlignment * this.profile.bulletApproachWeight);
    const specialMultiplier = (typeof bullet.isBeamLike === 'function' && bullet.isBeamLike() ? this.profile.beamThreatWeight : 1)
      * (bullet.isWarning ? this.profile.warningThreatWeight : 1);
    const threatMultiplier = motionMultiplier * specialMultiplier;
    let softThreat = 0;
    const threatPolyline = this.getSegmentLaserThreatPolyline(bullet);
    const inflate = this.profile.bulletThreatInflate;
    const polylineDistance = threatPolyline
      ? this.getPolylineDistanceToHitbox(threatPolyline.points, threatPolyline.thicknessPx + inflate, hitbox)
      : Number.POSITIVE_INFINITY;
    const projector = (bullet as any).getProjectedThreatRect;

    for (let frame = 1; frame <= lookAheadFrames; frame++) {
      const rawRect = typeof projector === 'function'
        ? projector.call(bullet, frame, 1000 / 60)
        : {
            x: bullet.x + bullet.vx * frame,
            y: bullet.y + bullet.vy * frame,
            width: bullet.width,
            height: bullet.height,
          };
      // inflate bullet rect so AI perceives threats as larger
      const bulletRect = {
        x: rawRect.x - inflate / 2,
        y: rawRect.y - inflate / 2,
        width: rawRect.width + inflate,
        height: rawRect.height + inflate,
      };

      const distance = Math.min(this.getRectDistanceToHitbox(bulletRect, hitbox), polylineDistance);

      if (distance <= 0) {
        return (1 + ((lookAheadFrames - frame + 1) / lookAheadFrames)) * threatMultiplier;
      }

      if (distance < 50) {
        softThreat = Math.max(softThreat, ((50 - distance) / 50) * 0.45 * threatMultiplier);
      }
    }

    return softThreat;
  }

  private buildDangerousBulletIndex(bullets: Bullet[]): BulletSpatialIndex {
    const sideBounds = this.getSideBounds();
    const cellSize = Math.max(72, Math.round(Math.min(sideBounds.maxX - sideBounds.minX, sideBounds.maxY - sideBounds.minY) / 6));
    const buckets = new Map<string, Bullet[]>();

    for (const bullet of bullets) {
      if (!bullet.active || bullet.category !== 'barrage') {
        continue;
      }

      const threatBounds = this.getBulletThreatBounds(bullet);
      this.insertRectIntoBulletGrid(buckets, cellSize, threatBounds, bullet);
    }

    return {
      buckets,
      cellSize,
      queryPadding: Math.max(72, this.profile.threatPadding + 48 + this.profile.bulletThreatInflate),
    };
  }

  private queryDangerousBulletsForCenter(index: BulletSpatialIndex, center: Vector2, hitboxRadius: number): Bullet[] {
    const queryRadius = hitboxRadius + index.queryPadding;
    return this.queryDangerousBulletsInRect(index, {
      x: center.x - queryRadius,
      y: center.y - queryRadius,
      width: queryRadius * 2,
      height: queryRadius * 2,
    });
  }

  private queryDangerousBulletsInRect(index: BulletSpatialIndex, rect: Rect): Bullet[] {
    if (index.buckets.size === 0) {
      return [];
    }

    const minCellX = Math.floor(rect.x / index.cellSize);
    const maxCellX = Math.floor((rect.x + rect.width) / index.cellSize);
    const minCellY = Math.floor(rect.y / index.cellSize);
    const maxCellY = Math.floor((rect.y + rect.height) / index.cellSize);
    const seen = new Set<Bullet>();
    const result: Bullet[] = [];

    for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
      for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
        const bucket = index.buckets.get(`${cellX}:${cellY}`);
        if (!bucket) {
          continue;
        }

        for (const bullet of bucket) {
          if (seen.has(bullet)) {
            continue;
          }

          seen.add(bullet);
          result.push(bullet);
        }
      }
    }

    return result;
  }

  private insertRectIntoBulletGrid(buckets: Map<string, Bullet[]>, cellSize: number, rect: Rect, bullet: Bullet) {
    const minCellX = Math.floor(rect.x / cellSize);
    const maxCellX = Math.floor((rect.x + rect.width) / cellSize);
    const minCellY = Math.floor(rect.y / cellSize);
    const maxCellY = Math.floor((rect.y + rect.height) / cellSize);

    for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
      for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
        const key = `${cellX}:${cellY}`;
        const bucket = buckets.get(key);

        if (bucket) {
          bucket.push(bullet);
          continue;
        }

        buckets.set(key, [bullet]);
      }
    }
  }

  private getBulletThreatBounds(bullet: Bullet): Rect {
    const projector = (bullet as any).getProjectedThreatRect;
    const threatPolyline = this.getSegmentLaserThreatPolyline(bullet);
    const inflate = this.profile.bulletThreatInflate;
    const currentRect = {
      x: bullet.x - inflate / 2,
      y: bullet.y - inflate / 2,
      width: bullet.width + inflate,
      height: bullet.height + inflate,
    };
    const projectedRect = typeof projector === 'function'
      ? projector.call(bullet, this.profile.lookAheadFrames, 1000 / 60)
      : {
          x: bullet.x + bullet.vx * this.profile.lookAheadFrames - inflate / 2,
          y: bullet.y + bullet.vy * this.profile.lookAheadFrames - inflate / 2,
          width: bullet.width + inflate,
          height: bullet.height + inflate,
        };

    const minX = Math.min(currentRect.x, projectedRect.x);
    const minY = Math.min(currentRect.y, projectedRect.y);
    const maxX = Math.max(currentRect.x + currentRect.width, projectedRect.x + projectedRect.width);
    const maxY = Math.max(currentRect.y + currentRect.height, projectedRect.y + projectedRect.height);

    if (threatPolyline) {
      const polylineRect = this.getPolylineBounds(threatPolyline.points, threatPolyline.thicknessPx + inflate);
      return {
        x: Math.min(minX, polylineRect.x),
        y: Math.min(minY, polylineRect.y),
        width: Math.max(maxX, polylineRect.x + polylineRect.width) - Math.min(minX, polylineRect.x),
        height: Math.max(maxY, polylineRect.y + polylineRect.height) - Math.min(minY, polylineRect.y),
      };
    }

    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
    };
  }

  private getDangerousBullets(): Bullet[] {
    return this.game
      .getBullets(this.side)
      .filter((bullet) => bullet.active && bullet.category === 'barrage');
  }

  private getMaxUsefulLevel(chargeMax: number): number {
    // New gauge design: top-level release can be achieved via hold-charge in hard mode.
    if (this.profile.allowUnlimitedTopSkill) return 4;
    if (chargeMax >= 80) return 4;
    if (chargeMax >= 60) return 3;
    if (chargeMax >= 40) return 2;
    if (chargeMax >= 20) return 1;
    return 0;
  }

  private getDesiredSkillLevelWithProfile(context: AIContext, plan: MovementPlan, maxUsefulLevel: number, prof: AIProfile): number {
    if (maxUsefulLevel <= 0) {
      return 0;
    }

    if (context.selfHealthRatio <= prof.lowHealthRatio) {
      return Math.min(1, maxUsefulLevel);
    }

    if (context.currentThreat >= prof.panicThreatThreshold) {
      return Math.min(2, maxUsefulLevel);
    }

    let pressure = plan.pressureScore;

    if (context.boss && context.boss.side !== this.side) {
      pressure += prof.bossPressureBonus;
    }

    if (context.opponentHealthRatio <= 0.35) {
      pressure += prof.opponentLowHealthBonus;
    }

    if (pressure >= prof.pressureThresholds[3]) {
      return Math.min(4, maxUsefulLevel);
    }

    if (pressure >= prof.pressureThresholds[2]) {
      return Math.min(3, maxUsefulLevel);
    }

    if (pressure >= prof.pressureThresholds[1]) {
      return Math.min(2, maxUsefulLevel);
    }

    if (pressure >= prof.pressureThresholds[0]) {
      return Math.min(1, maxUsefulLevel);
    }

    // With unlimited top-level release enabled, keep charging for level 4 under mild pressure.
    if (prof.allowUnlimitedTopSkill && pressure > 0.35 && context.currentThreat < prof.panicThreatThreshold) {
      return 4;
    }

    return 0;
  }

  private getProfile(difficulty: Difficulty): AIProfile {
    switch (difficulty) {
      case 'easy':
        return {
          decisionInterval: 180,
          lookAheadFrames: 16,
          laneSamples: 5,
          threatPadding: 22,
          threatWeight: 1.95,
          attackWeight: 0.95,
          moveWeight: 0.011,
          edgeWeight: 0.32,
          centerBiasWeight: 0.16,
          edgeDwellWeight: 0.8,
          bulletApproachWeight: 0.55,
          beamThreatWeight: 1.45,
          warningThreatWeight: 1.08,
          randomJitter: 0.3,
          deadZone: 12,
          tapHoldMs: 150,
          postActionCooldownMs: 150,
          releaseWindows: [150, 520, 940, 1380, 1760],
          pressureThresholds: [0.65, 1.8, 3.1, 4.6],
          pressureThreatPenalty: 0.52,
          panicThreatThreshold: 2.5,
          lowHealthRatio: 0.35,
          enemyLaneWidth: 108,
          bossPressureBonus: 1.05,
          opponentLowHealthBonus: 0.8,
          bombThreatThreshold: 2.8,
          bombNearbyThreshold: 9,
          bossBombHealthThreshold: 0.26,
          allowUnlimitedTopSkill: false,
          opportunisticBurstThreatMax: 1.15,
          enemyBodyThreatWeight: 0.75,
          enemyBodyLookAheadFrames: 20,
          enemyBodySpeedEstimate: 3.75,
          idleProbeFireIntervalMs: 360,
          minNonBombSkillIntervalMs: 1050,
          bulletThreatInflate: 20,
        };
      case 'hard':
        return {
          decisionInterval: 48,
          lookAheadFrames: 46,
          laneSamples: 10,
          threatPadding: 11,
          threatWeight: 3.45,
          attackWeight: 2.05,
          moveWeight: 0.006,
          edgeWeight: 0.18,
          centerBiasWeight: 0.14,
          edgeDwellWeight: 1.05,
          bulletApproachWeight: 0.8,
          beamThreatWeight: 1.8,
          warningThreatWeight: 1.1,
          randomJitter: 0.03,
          deadZone: 4,
          tapHoldMs: 80,
          postActionCooldownMs: 35,
          releaseWindows: [80, 260, 520, 790, 1050],
          pressureThresholds: [0.15, 0.8, 1.55, 2.35],
          pressureThreatPenalty: 0.24,
          panicThreatThreshold: 3.8,
          lowHealthRatio: 0.18,
          enemyLaneWidth: 82,
          bossPressureBonus: 2.1,
          opponentLowHealthBonus: 1.8,
          bombThreatThreshold: 3.6,
          bombNearbyThreshold: 6,
          bossBombHealthThreshold: 0.38,
          allowUnlimitedTopSkill: true,
          opportunisticBurstThreatMax: 0.95,
          enemyBodyThreatWeight: 1.3,
          enemyBodyLookAheadFrames: 34,
          enemyBodySpeedEstimate: 3.75,
          idleProbeFireIntervalMs: 240,
          minNonBombSkillIntervalMs: 680,
          bulletThreatInflate: 8,
        };
      case 'normal':
      default:
        return {
          decisionInterval: 120,
          lookAheadFrames: 24,
          laneSamples: 6,
          threatPadding: 18,
          threatWeight: 2.35,
          attackWeight: 1.45,
          moveWeight: 0.01,
          edgeWeight: 0.28,
          centerBiasWeight: 0.2,
          edgeDwellWeight: 0.95,
          bulletApproachWeight: 0.65,
          beamThreatWeight: 1.6,
          warningThreatWeight: 1.05,
          randomJitter: 0.15,
          deadZone: 9,
          tapHoldMs: 120,
          postActionCooldownMs: 90,
          releaseWindows: [120, 430, 820, 1240, 1600],
          pressureThresholds: [0.45, 1.55, 2.65, 4.05],
          pressureThreatPenalty: 0.42,
          panicThreatThreshold: 2.9,
          lowHealthRatio: 0.28,
          enemyLaneWidth: 98,
          bossPressureBonus: 1.35,
          opponentLowHealthBonus: 1.1,
          bombThreatThreshold: 3.4,
          bombNearbyThreshold: 8,
          bossBombHealthThreshold: 0.3,
          allowUnlimitedTopSkill: false,
          opportunisticBurstThreatMax: 1.05,
          enemyBodyThreatWeight: 1,
          enemyBodyLookAheadFrames: 26,
          enemyBodySpeedEstimate: 3.75,
          idleProbeFireIntervalMs: 300,
          minNonBombSkillIntervalMs: 850,
          bulletThreatInflate: 14,
        };
    }
  }

  // ---------------------------------------------------------------------------
  // Phase state machine implementation
  // ---------------------------------------------------------------------------

  /**
   * Compute the current match phase from elapsed time and health ratios.
   *
   * Health-driven transitions (survival) can override time-based phases at
   * any point, exactly as PoDD overrides its scripted timing when health drops
   * into critical territory.
   */
  private computeMatchPhase(): MatchPhase {
    const selfHealth = this.player.health / 100;
    const opponentSide = this.getOpponentSide();
    const opponentPlayer = this.game.getPlayer(opponentSide);
    const opponentHealth = opponentPlayer ? opponentPlayer.health / 100 : 1;
    const minHealth = Math.min(selfHealth, opponentHealth);

    // Survival phase: either player is critically low — shift to full defense.
    if (selfHealth <= 0.20 || minHealth <= 0.15) {
      return 'survival';
    }

    // Endgame: either player is below 40 % OR the match has run long.
    if (minHealth <= 0.40 || this.matchElapsedMs >= PHASE_MIDGAME_END_MS) {
      return 'endgame';
    }

    // Opening phase: first 18 seconds of the match.
    if (this.matchElapsedMs < PHASE_OPENING_END_MS) {
      return 'opening';
    }

    return 'midgame';
  }

  /**
   * Return a copy of the base difficulty profile with phase-specific
   * multipliers applied to the parameters that most affect tactical choices.
   *
   * Only the parameters relevant to macro-level phase control are adjusted;
   * low-level physics constants (deadZone, releaseWindows, etc.) stay fixed.
   */
  private computePhaseProfile(): AIProfile {
    const adj = PHASE_ADJUSTMENTS[this.currentPhase];

    return {
      ...this.profile,
      attackWeight: this.profile.attackWeight * adj.attackWeightScale,
      threatWeight: this.profile.threatWeight * adj.threatWeightScale,
      bombThreatThreshold: this.profile.bombThreatThreshold * adj.bombThreatScale,
      bombNearbyThreshold: Math.round(this.profile.bombNearbyThreshold * adj.bombNearbyScale),
      panicThreatThreshold: this.profile.panicThreatThreshold * adj.panicThreatScale,
      randomJitter: this.profile.randomJitter * adj.randomJitterScale,
      opponentLowHealthBonus: this.profile.opponentLowHealthBonus * adj.opponentLowHealthBonusScale,
    };
  }

  private getOpponentSide(): PlayerSide {
    return this.side === 'left' ? 'right' : 'left';
  }

  private getPlayerCenter(): Vector2 {
    const hitbox = this.getPlayerHitbox();
    return {
      x: hitbox.x,
      y: hitbox.y,
    };
  }

  private getPlayerHitbox(): HitboxCircle {
    return this.player.getHitbox();
  }

  private getBulletCenter(bullet: Bullet): Vector2 {
    return {
      x: bullet.x + bullet.width / 2,
      y: bullet.y + bullet.height / 2,
    };
  }

  private getInflatedRect(center: Vector2, padding: number): Rect {
    return {
      x: center.x - this.player.width / 2 - padding,
      y: center.y - this.player.height / 2 - padding,
      width: this.player.width + padding * 2,
      height: this.player.height + padding * 2,
    };
  }

  private inflateHitbox(hitbox: HitboxCircle, padding: number): HitboxCircle {
    return {
      x: hitbox.x,
      y: hitbox.y,
      radius: hitbox.radius + padding,
    };
  }

  private getRectDistanceToHitbox(rect: Rect, hitbox: HitboxCircle): number {
    const nearestX = Math.max(rect.x, Math.min(hitbox.x, rect.x + rect.width));
    const nearestY = Math.max(rect.y, Math.min(hitbox.y, rect.y + rect.height));
    return Math.max(0, Math.hypot(hitbox.x - nearestX, hitbox.y - nearestY) - hitbox.radius);
  }

  private getSegmentLaserThreatPolyline(bullet: Bullet): PolylineThreatGeometry | null {
    const projector = (bullet as any).getSegmentLaserThreatPolyline;
    if (typeof projector !== 'function') {
      return null;
    }

    const threatPolyline = projector.call(bullet) as PolylineThreatGeometry | null;
    if (!threatPolyline || !Array.isArray(threatPolyline.points) || threatPolyline.points.length < 2) {
      return null;
    }

    return threatPolyline;
  }

  private getPolylineBounds(points: Vector2[], thicknessPx: number): Rect {
    if (points.length === 0) {
      return { x: 0, y: 0, width: 0, height: 0 };
    }

    let minX = points[0].x;
    let maxX = points[0].x;
    let minY = points[0].y;
    let maxY = points[0].y;

    for (let index = 1; index < points.length; index++) {
      const point = points[index];
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y);
      maxY = Math.max(maxY, point.y);
    }

    const padding = Math.max(0, thicknessPx / 2);
    return {
      x: minX - padding,
      y: minY - padding,
      width: Math.max(0, maxX - minX) + padding * 2,
      height: Math.max(0, maxY - minY) + padding * 2,
    };
  }

  private getPolylineDistanceToHitbox(points: Vector2[], thicknessPx: number, hitbox: HitboxCircle): number {
    if (points.length < 2) {
      return Number.POSITIVE_INFINITY;
    }

    const effectiveRadius = hitbox.radius + Math.max(0, thicknessPx / 2);
    let minDistance = Number.POSITIVE_INFINITY;

    for (let index = 0; index < points.length - 1; index++) {
      const nearest = this.closestPointOnSegment(hitbox.x, hitbox.y, points[index], points[index + 1]);
      const distance = Math.max(0, Math.hypot(hitbox.x - nearest.x, hitbox.y - nearest.y) - effectiveRadius);
      minDistance = Math.min(minDistance, distance);
    }

    return minDistance;
  }

  private closestPointOnSegment(px: number, py: number, start: Vector2, end: Vector2): Vector2 {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;

    if (lengthSquared <= 1e-6) {
      return { x: start.x, y: start.y };
    }

    const t = this.clamp(((px - start.x) * dx + (py - start.y) * dy) / lengthSquared, 0, 1);
    return {
      x: start.x + dx * t,
      y: start.y + dy * t,
    };
  }

  private getSideBounds() {
    const screenWidth = this.game.getScreenWidth();
    const screenHeight = this.game.getScreenHeight();
    const margin = this.game.getMargin();
    const halfWidth = screenWidth * 0.5;
    const marginWidth = screenWidth * margin / 2;
    const halfPlayerWidth = this.player.width / 2;
    const halfPlayerHeight = this.player.height / 2;

    if (this.side === 'left') {
      return {
        minX: halfPlayerWidth,
        maxX: halfWidth - marginWidth - halfPlayerWidth,
        minY: screenHeight * 0.4 + halfPlayerHeight,
        maxY: screenHeight - halfPlayerHeight,
      };
    }

    return {
      minX: halfWidth + marginWidth + halfPlayerWidth,
      maxX: screenWidth - halfPlayerWidth,
      minY: screenHeight * 0.4 + halfPlayerHeight,
      maxY: screenHeight - halfPlayerHeight,
    };
  }

  private computeEdgePenalty(candidateX: number, bounds: { minX: number; maxX: number }): number {
    const edgeBuffer = 32;
    const leftGap = candidateX - bounds.minX;
    const rightGap = bounds.maxX - candidateX;
    const nearEdge = Math.min(leftGap, rightGap);

    if (nearEdge >= edgeBuffer) {
      return 0;
    }

    return (edgeBuffer - nearEdge) / edgeBuffer;
  }

  private updateEdgeDwell(deltaTime: number) {
    const bounds = this.getSideBounds();
    const center = this.getPlayerCenter();
    const leftGap = center.x - bounds.minX;
    const rightGap = bounds.maxX - center.x;
    const nearestEdgeGap = Math.min(leftGap, rightGap);
    const edgeBuffer = Math.max(28, (bounds.maxX - bounds.minX) * 0.14);

    if (nearestEdgeGap < edgeBuffer) {
      const edgeProximity = 1 - this.clamp(nearestEdgeGap / edgeBuffer, 0, 1);
      this.edgeDwellMs = Math.min(5000, this.edgeDwellMs + deltaTime * (0.5 + edgeProximity));
      return;
    }

    this.edgeDwellMs = Math.max(0, this.edgeDwellMs - deltaTime * 0.9);
  }

  private rectsOverlap(a: Rect, b: Rect): boolean {
    return a.x < b.x + b.width
      && a.x + a.width > b.x
      && a.y < b.y + b.height
      && a.y + a.height > b.y;
  }

  private distance(a: Vector2, b: Vector2): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }
}
