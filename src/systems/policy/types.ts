import type { Observation } from '../../entities/types';

export type PolicyFormat = 'bc-mlp-v1';
export type PolicyActivation = 'relu';
export type PolicySourceKind = 'auto' | 'json' | 'onnx' | 'tfjs';
export type NativeModelKind = 'onnx' | 'tfjs';

export type MoveLabel =
  | 'stay'
  | 'left'
  | 'right'
  | 'up'
  | 'down'
  | 'up-left'
  | 'up-right'
  | 'down-left'
  | 'down-right';

export type FireLabel = 'keepGun' | 'stopGun';
export type SkillLabel = 'none' | 'skill1' | 'skill2' | 'skill3' | 'skill4' | 'bomb';

export interface LinearLayerSpec {
  weights: number[][];
  bias: number[];
}

export interface BCPolicySpec {
  format: PolicyFormat;
  featureNames: string[];
  hiddenSizes: number[];
  activation: PolicyActivation;
  outputLabels: {
    move: MoveLabel[];
    fire: FireLabel[];
    skill: SkillLabel[];
  };
  normalization: {
    mean: number[];
    std: number[];
  };
  trunk: LinearLayerSpec[];
  heads: {
    move: LinearLayerSpec;
    fire: LinearLayerSpec;
    skill: LinearLayerSpec;
  };
  training?: {
    epochs?: number;
    batchSize?: number;
    learningRate?: number;
    datasetSize?: number;
    validationSize?: number;
  };
}

export interface PolicyDecision {
  move: MoveLabel;
  fire: FireLabel;
  skill: SkillLabel;
  moveIndex: number;
  fireIndex: number;
  skillIndex: number;
  confidence: number;
}

export interface PolicyDecisionProvider {
  decide(observation: Observation): PolicyDecision | Promise<PolicyDecision>;
}

export interface NativePolicyManifest {
  format: 'bc-native-v1';
  featureNames: string[];
  outputLabels: {
    move: MoveLabel[];
    fire: FireLabel[];
    skill: SkillLabel[];
  };
  normalization: {
    mean: number[];
    std: number[];
  };
  model: {
    inputName: string;
    outputNames: {
      move: string;
      fire: string;
      skill: string;
    };
  };
}

export interface PolicyLoadResult {
  kind: Exclude<PolicySourceKind, 'auto'>;
  label: string;
  provider: PolicyDecisionProvider;
  manifest: BCPolicySpec | NativePolicyManifest;
}