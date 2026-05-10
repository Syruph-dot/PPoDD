import type { Observation } from '../../entities/types';
import { MAX_BULLET_SLOTS, MAX_ENEMY_SLOTS, MOVE_LABELS, FIRE_LABELS, SKILL_LABELS, buildPolicyFeatureNames, sideToOneHot } from './featureLayout';
import type { BCPolicySpec, LinearLayerSpec, PolicyDecision, PolicyDecisionProvider } from './types';

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function numberOrZero(value: unknown): number {
  return isFiniteNumber(value) ? value : 0;
}

function boolToNumber(value: unknown): number {
  return value ? 1 : 0;
}

function relu(value: number): number {
  return value > 0 ? value : 0;
}

function argMax(values: number[]): number {
  let bestIndex = 0;
  let bestValue = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value > bestValue) {
      bestValue = value;
      bestIndex = index;
    }
  }

  return bestIndex;
}

function softmax(values: number[]): number[] {
  if (values.length === 0) {
    return [];
  }

  const maxValue = Math.max(...values);
  const exps = values.map((value) => Math.exp(value - maxValue));
  const total = exps.reduce((sum, value) => sum + value, 0) || 1;
  return exps.map((value) => value / total);
}

function dense(inputs: number[], layer: LinearLayerSpec): number[] {
  const outputs: number[] = new Array(layer.bias.length).fill(0);

  for (let row = 0; row < layer.weights.length; row += 1) {
    const weightsRow = layer.weights[row];
    let sum = layer.bias[row] ?? 0;
    for (let column = 0; column < weightsRow.length; column += 1) {
      sum += (inputs[column] ?? 0) * (weightsRow[column] ?? 0);
    }
    outputs[row] = sum;
  }

  return outputs;
}

function makeZeroLayer(outputSize: number, inputSize: number): LinearLayerSpec {
  return {
    weights: Array.from({ length: outputSize }, () => new Array(inputSize).fill(0)),
    bias: new Array(outputSize).fill(0),
  };
}

export function normalizeFeatureVector(values: number[], mean: number[], std: number[]): number[] {
  return values.map((value, index) => {
    const meanValue = mean[index] ?? 0;
    const stdValue = Math.abs(std[index] ?? 1) < 1e-8 ? 1 : std[index] ?? 1;
    return (value - meanValue) / stdValue;
  });
}

export function flattenObservation(observation: Observation): number[] {
  const features: number[] = [];
  const selfSide = observation.self.side ?? (observation.self.pos.x < observation.screen.width / 2 ? 'left' : 'right');
  const [selfLeft, selfRight] = sideToOneHot(selfSide);

  features.push(selfLeft, selfRight);

  const selfCurrentCharge = numberOrZero(observation.self.currentCharge);
  const selfChargeMax = Math.max(1, numberOrZero(observation.self.chargeMax));
  features.push(
    numberOrZero(observation.self.pos.x),
    numberOrZero(observation.self.pos.y),
    numberOrZero(observation.self.vel.vx),
    numberOrZero(observation.self.vel.vy),
    numberOrZero(observation.self.health),
    numberOrZero(observation.self.bombs),
    selfCurrentCharge,
    selfChargeMax,
    boolToNumber(observation.self.isCharging),
  );

  const opponentCurrentCharge = numberOrZero(observation.opponent?.currentCharge);
  const opponentChargeMax = Math.max(1, numberOrZero(observation.opponent?.chargeMax));
  features.push(
    numberOrZero(observation.opponent?.pos.x),
    numberOrZero(observation.opponent?.pos.y),
    numberOrZero(observation.opponent?.vel.vx),
    numberOrZero(observation.opponent?.vel.vy),
    numberOrZero(observation.opponent?.health),
    numberOrZero(observation.opponent?.bombs),
    opponentCurrentCharge,
    opponentChargeMax,
    boolToNumber(observation.opponent?.isCharging),
  );

  const [bossLeft, bossRight] = observation.boss ? sideToOneHot(observation.boss.side) : [0, 0];
  features.push(
    boolToNumber(observation.boss),
    numberOrZero(observation.boss?.pos.x),
    numberOrZero(observation.boss?.pos.y),
    numberOrZero(observation.boss?.width),
    numberOrZero(observation.boss?.height),
    observation.boss ? numberOrZero(observation.boss.health) / Math.max(1, numberOrZero(observation.boss.maxHealth)) : 0,
    boolToNumber(observation.boss?.canTakeDamage),
    bossLeft,
    bossRight,
  );

  features.push(
    numberOrZero(observation.screen.width),
    numberOrZero(observation.screen.height),
    numberOrZero(observation.screen.margin),
    numberOrZero(observation.arena.currentThreat),
    numberOrZero(observation.arena.nearbyBulletCount),
    numberOrZero(observation.arena.decisionIntervalMs),
  );

  for (let index = 0; index < MAX_ENEMY_SLOTS; index += 1) {
    const enemy = observation.enemies[index];
    if (!enemy) {
      features.push(0, 0, 0, 0, 0, 0);
      continue;
    }

    features.push(
      1,
      numberOrZero(enemy.pos.x) - numberOrZero(observation.self.pos.x),
      numberOrZero(enemy.pos.y) - numberOrZero(observation.self.pos.y),
      numberOrZero(enemy.width),
      numberOrZero(enemy.height),
        numberOrZero(enemy.health) / Math.max(1, numberOrZero(enemy.maxHealth) || 2),
    );
  }

  for (let index = 0; index < MAX_BULLET_SLOTS; index += 1) {
    const bullet = observation.bullets[index];
    if (!bullet) {
      features.push(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
      continue;
    }

    const categoryBarrage = bullet.category === 'barrage' ? 1 : 0;
    const categoryPlayer1 = bullet.category === 'player1' ? 1 : 0;
    const categoryPlayer2 = bullet.category === 'player2' ? 1 : 0;

    features.push(
      1,
      numberOrZero(bullet.pos.x) - numberOrZero(observation.self.pos.x),
      numberOrZero(bullet.pos.y) - numberOrZero(observation.self.pos.y),
        numberOrZero(bullet.vel.vx),
        numberOrZero(bullet.vel.vy),
      numberOrZero(bullet.width),
      numberOrZero(bullet.height),
      numberOrZero(bullet.damage),
      boolToNumber(bullet.isBeamLike),
      boolToNumber(bullet.isWarning),
      boolToNumber(bullet.canBeDestroyed),
      boolToNumber(bullet.isCircular),
      categoryBarrage,
      categoryPlayer1,
      categoryPlayer2,
    );
  }

  return features;
}

export class JsonPolicyAdapter implements PolicyDecisionProvider {
  private readonly spec: BCPolicySpec;

  constructor(spec: BCPolicySpec) {
    const expectedFeatureNames = buildPolicyFeatureNames();
    if (spec.format !== 'bc-mlp-v1') {
      throw new Error(`Unsupported policy format: ${spec.format}`);
    }
    if (!Array.isArray(spec.featureNames) || spec.featureNames.length !== expectedFeatureNames.length) {
      throw new Error(`Policy feature count mismatch: expected ${expectedFeatureNames.length}, got ${spec.featureNames?.length ?? 0}`);
    }
    for (let index = 0; index < expectedFeatureNames.length; index += 1) {
      if (spec.featureNames[index] !== expectedFeatureNames[index]) {
        throw new Error(`Policy feature order mismatch at index ${index}: expected ${expectedFeatureNames[index]}, got ${spec.featureNames[index]}`);
      }
    }

    this.spec = spec;
  }

  decide(observation: Observation): PolicyDecision {
    const rawFeatures = flattenObservation(observation);
    const normalized = normalizeFeatureVector(rawFeatures, this.spec.normalization.mean, this.spec.normalization.std);

    let hidden = normalized;
    for (const layer of this.spec.trunk) {
      hidden = dense(hidden, layer).map(relu);
    }

    const moveLogits = dense(hidden, this.spec.heads.move);
    const fireLogits = dense(hidden, this.spec.heads.fire);
    const skillLogits = dense(hidden, this.spec.heads.skill);

    const moveIndex = argMax(moveLogits);
    const fireIndex = argMax(fireLogits);
    const skillIndex = argMax(skillLogits);

    const move = this.spec.outputLabels.move[moveIndex] ?? MOVE_LABELS[0];
    const fire = this.spec.outputLabels.fire[fireIndex] ?? FIRE_LABELS[0];
    const skill = this.spec.outputLabels.skill[skillIndex] ?? SKILL_LABELS[0];

    const moveConfidence = softmax(moveLogits)[moveIndex] ?? 0;
    const fireConfidence = softmax(fireLogits)[fireIndex] ?? 0;
    const skillConfidence = softmax(skillLogits)[skillIndex] ?? 0;

    return {
      move,
      fire,
      skill,
      moveIndex,
      fireIndex,
      skillIndex,
      confidence: (moveConfidence + fireConfidence + skillConfidence) / 3,
    };
  }
}

export function createDefaultPolicySpec(): BCPolicySpec {
  const featureNames = buildPolicyFeatureNames();

  return {
    format: 'bc-mlp-v1',
    featureNames,
    hiddenSizes: [],
    activation: 'relu',
    outputLabels: {
      move: [...MOVE_LABELS],
      fire: [...FIRE_LABELS],
      skill: [...SKILL_LABELS],
    },
    normalization: {
      mean: new Array(featureNames.length).fill(0),
      std: new Array(featureNames.length).fill(1),
    },
    trunk: [],
    heads: {
      move: makeZeroLayer(MOVE_LABELS.length, featureNames.length),
      fire: makeZeroLayer(FIRE_LABELS.length, featureNames.length),
      skill: makeZeroLayer(SKILL_LABELS.length, featureNames.length),
    },
  };
}