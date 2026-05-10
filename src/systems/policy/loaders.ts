import { flattenObservation, normalizeFeatureVector, JsonPolicyAdapter } from './jsonPolicy';
import { buildPolicyFeatureNames, FIRE_LABELS, MOVE_LABELS, SKILL_LABELS } from './featureLayout';
import type {
  BCPolicySpec,
  NativePolicyManifest,
  PolicyDecision,
  PolicyDecisionProvider,
  PolicyLoadResult,
  PolicySourceKind,
} from './types';

type AnyFile = File & { webkitRelativePath?: string };

function getFilePath(file: AnyFile): string {
  return (file.webkitRelativePath || file.name || '').replace(/\\/g, '/').toLowerCase();
}

function isJsonLikeFile(file: AnyFile): boolean {
  return getFilePath(file).endsWith('.json');
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'number' && Number.isFinite(item));
}

function hasValidManifestShape(value: unknown): value is NativePolicyManifest {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const manifest = value as NativePolicyManifest;
  return manifest.format === 'bc-native-v1'
    && Array.isArray(manifest.featureNames)
    && Array.isArray(manifest.outputLabels?.move)
    && Array.isArray(manifest.outputLabels?.fire)
    && Array.isArray(manifest.outputLabels?.skill)
    && isNumberArray(manifest.normalization?.mean)
    && isNumberArray(manifest.normalization?.std)
    && typeof manifest.model?.inputName === 'string'
    && typeof manifest.model?.outputNames?.move === 'string'
    && typeof manifest.model?.outputNames?.fire === 'string'
    && typeof manifest.model?.outputNames?.skill === 'string';
}

function hasValidJsonPolicyShape(value: unknown): value is BCPolicySpec {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const spec = value as BCPolicySpec;
  return spec.format === 'bc-mlp-v1'
    && Array.isArray(spec.featureNames)
    && Array.isArray(spec.outputLabels?.move)
    && Array.isArray(spec.outputLabels?.fire)
    && Array.isArray(spec.outputLabels?.skill)
    && isNumberArray(spec.normalization?.mean)
    && isNumberArray(spec.normalization?.std)
    && Array.isArray(spec.trunk)
    && typeof spec.heads?.move === 'object'
    && typeof spec.heads?.fire === 'object'
    && typeof spec.heads?.skill === 'object';
}

function validateFeatureNames(featureNames: string[]) {
  const expected = buildPolicyFeatureNames();
  if (featureNames.length !== expected.length) {
    throw new Error(`Policy feature count mismatch: expected ${expected.length}, got ${featureNames.length}`);
  }

  for (let index = 0; index < expected.length; index += 1) {
    if (featureNames[index] !== expected[index]) {
      throw new Error(`Policy feature order mismatch at index ${index}: expected ${expected[index]}, got ${featureNames[index]}`);
    }
  }
}

function validateOutputLabels(manifest: NativePolicyManifest) {
  const move = [...MOVE_LABELS];
  const fire = [...FIRE_LABELS];
  const skill = [...SKILL_LABELS];

  if (manifest.outputLabels.move.join('|') !== move.join('|')) {
    throw new Error('Native policy move labels do not match the expected action space.');
  }

  if (manifest.outputLabels.fire.join('|') !== fire.join('|')) {
    throw new Error('Native policy fire labels do not match the expected action space.');
  }

  if (manifest.outputLabels.skill.join('|') !== skill.join('|')) {
    throw new Error('Native policy skill labels do not match the expected action space.');
  }
}

function convertBcPolicySpecToNativeManifest(spec: BCPolicySpec): NativePolicyManifest {
  validateFeatureNames(spec.featureNames);

  const manifest: NativePolicyManifest = {
    format: 'bc-native-v1',
    featureNames: spec.featureNames,
    outputLabels: spec.outputLabels,
    normalization: spec.normalization,
    model: {
      inputName: 'input',
      outputNames: {
        move: 'move_logits',
        fire: 'fire_logits',
        skill: 'skill_logits',
      },
    },
  };

  validateOutputLabels(manifest);
  return manifest;
}

function flattenArray(value: unknown): number[] {
  if (Array.isArray(value)) {
    return value.flat(Infinity).map((item) => Number(item ?? 0));
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return [value];
  }

  if (ArrayBuffer.isView(value)) {
    return Array.from(value as unknown as ArrayLike<number>);
  }

  return [];
}

function tensorToNumbers(value: unknown): number[] {
  if (!value) {
    return [];
  }

  const maybeTensor = value as {
    dataSync?: () => ArrayLike<number>;
    arraySync?: () => unknown;
    data?: ArrayLike<number>;
  };

  if (typeof maybeTensor.dataSync === 'function') {
    return Array.from(maybeTensor.dataSync());
  }

  if (typeof maybeTensor.arraySync === 'function') {
    return flattenArray(maybeTensor.arraySync());
  }

  if (maybeTensor.data && typeof maybeTensor.data.length === 'number') {
    return Array.from(maybeTensor.data);
  }

  return flattenArray(value);
}

function argMax(values: number[]): number {
  let bestIndex = 0;
  let bestValue = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < values.length; index += 1) {
    if (values[index] > bestValue) {
      bestValue = values[index];
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

function makeDecisionFromLogits(
  moveLogits: number[],
  fireLogits: number[],
  skillLogits: number[],
  labels: NativePolicyManifest['outputLabels'],
): PolicyDecision {
  const moveIndex = argMax(moveLogits);
  const fireIndex = argMax(fireLogits);
  const skillIndex = argMax(skillLogits);

  const move = labels.move[moveIndex] ?? MOVE_LABELS[0];
  const fire = labels.fire[fireIndex] ?? FIRE_LABELS[0];
  const skill = labels.skill[skillIndex] ?? SKILL_LABELS[0];

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

function splitCombinedLogits(values: number[], labels: NativePolicyManifest['outputLabels']): {
  move: number[];
  fire: number[];
  skill: number[];
} | null {
  const moveCount = labels.move.length;
  const fireCount = labels.fire.length;
  const skillCount = labels.skill.length;
  const required = moveCount + fireCount + skillCount;

  if (values.length < required) {
    return null;
  }

  return {
    move: values.slice(0, moveCount),
    fire: values.slice(moveCount, moveCount + fireCount),
    skill: values.slice(moveCount + fireCount, moveCount + fireCount + skillCount),
  };
}

function makeDecisionFromOutputs(outputValues: ArrayLike<unknown>, labels: NativePolicyManifest['outputLabels']): PolicyDecision {
  const tensors = Array.from(outputValues, (value) => tensorToNumbers(value));

  if (tensors.length >= 3) {
    return makeDecisionFromLogits(tensors[0], tensors[1], tensors[2], labels);
  }

  if (tensors.length === 1) {
    const combined = splitCombinedLogits(tensors[0], labels);
    if (combined) {
      return makeDecisionFromLogits(combined.move, combined.fire, combined.skill, labels);
    }
  }

  throw new Error('Native policy model did not return enough outputs to build an action decision.');
}

function makeDecisionFromOutputMap(
  outputMap: Record<string, unknown>,
  manifest: NativePolicyManifest,
): PolicyDecision {
  const namedMove = outputMap[manifest.model.outputNames.move] ?? outputMap.move_logits ?? outputMap.move ?? null;
  const namedFire = outputMap[manifest.model.outputNames.fire] ?? outputMap.fire_logits ?? outputMap.fire ?? null;
  const namedSkill = outputMap[manifest.model.outputNames.skill] ?? outputMap.skill_logits ?? outputMap.skill ?? null;

  if (namedMove && namedFire && namedSkill) {
    return makeDecisionFromLogits(
      tensorToNumbers(namedMove),
      tensorToNumbers(namedFire),
      tensorToNumbers(namedSkill),
      manifest.outputLabels,
    );
  }

  return makeDecisionFromOutputs(Object.values(outputMap), manifest.outputLabels);
}

class OnnxPolicyAdapter implements PolicyDecisionProvider {
  private readonly ort: any;
  private readonly session: any;
  private readonly manifest: NativePolicyManifest;

  constructor(ort: any, session: any, manifest: NativePolicyManifest) {
    this.ort = ort;
    this.session = session;
    this.manifest = manifest;
  }

  async decide(observation: Parameters<PolicyDecisionProvider['decide']>[0]): Promise<PolicyDecision> {
    const features = normalizeFeatureVector(
      flattenObservation(observation),
      this.manifest.normalization.mean,
      this.manifest.normalization.std,
    );

    const inputName = this.manifest.model.inputName || this.session.inputNames?.[0] || 'input';
    const inputTensor = new this.ort.Tensor('float32', Float32Array.from(features), [1, features.length]);
    let decision: PolicyDecision | null = null;
    try {
      const outputMap = await this.session.run({ [inputName]: inputTensor });
      decision = makeDecisionFromOutputMap(outputMap as Record<string, unknown>, this.manifest);

      for (const outputTensor of Object.values(outputMap)) {
        if (typeof (outputTensor as any)?.dispose === 'function') {
          (outputTensor as any).dispose();
        }
      }
    } finally {
      if (typeof (inputTensor as any).dispose === 'function') {
        (inputTensor as any).dispose();
      }
    }

    if (!decision) {
      throw new Error('ONNX policy inference returned no outputs.');
    }

    return decision;
  }
}

class TfjsPolicyAdapter implements PolicyDecisionProvider {
  private readonly model: any;
  private readonly manifest: NativePolicyManifest;
  private readonly tf: any;

  constructor(tf: any, model: any, manifest: NativePolicyManifest) {
    this.tf = tf;
    this.model = model;
    this.manifest = manifest;
  }

  decide(observation: Parameters<PolicyDecisionProvider['decide']>[0]): PolicyDecision {
    const features = normalizeFeatureVector(
      flattenObservation(observation),
      this.manifest.normalization.mean,
      this.manifest.normalization.std,
    );

    const inputTensor = this.tf.tensor2d([features], [1, features.length], 'float32');
    const prediction = this.model.predict(inputTensor);
    const outputs = Array.isArray(prediction) ? prediction : [prediction];

    const decision = makeDecisionFromOutputs(outputs, this.manifest.outputLabels);

    this.tf.dispose(inputTensor);
    for (const output of outputs) {
      this.tf.dispose(output);
    }

    return decision;
  }
}

async function parseJsonFile(file: AnyFile): Promise<unknown> {
  return JSON.parse(await file.text());
}

function pickFileBySuffix(files: AnyFile[], suffix: string): AnyFile | null {
  return files.find((file) => getFilePath(file).endsWith(suffix)) ?? null;
}

function pickFileByName(files: AnyFile[], expectedName: string): AnyFile | null {
  const normalized = expectedName.toLowerCase();
  return files.find((file) => getFilePath(file).endsWith(normalized)) ?? null;
}

function getParentDirectory(path: string): string {
  const normalized = path.replace(/\\/g, '/').toLowerCase();
  const index = normalized.lastIndexOf('/');
  return index >= 0 ? normalized.slice(0, index + 1) : '';
}

function resolveFileByRelativePath(files: AnyFile[], baseDir: string, relativePath: string): AnyFile | null {
  const normalizedBaseDir = baseDir.replace(/\\/g, '/').toLowerCase();
  const normalizedRelativePath = relativePath.replace(/\\/g, '/').toLowerCase();
  const directPath = `${normalizedBaseDir}${normalizedRelativePath}`.replace(/\/+/g, '/');

  return files.find((file) => {
    const filePath = getFilePath(file);
    return filePath === directPath || filePath === normalizedRelativePath || filePath.endsWith(`/${normalizedRelativePath}`);
  }) ?? null;
}

function concatArrayBuffers(buffers: ArrayBuffer[]): ArrayBuffer {
  const totalLength = buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;

  for (const buffer of buffers) {
    merged.set(new Uint8Array(buffer), offset);
    offset += buffer.byteLength;
  }

  return merged.buffer;
}

async function loadJsonPolicy(files: AnyFile[]): Promise<PolicyLoadResult> {
  for (const file of files.filter(isJsonLikeFile)) {
    const parsed = await parseJsonFile(file);
    if (!hasValidJsonPolicyShape(parsed)) {
      continue;
    }

    const spec = parsed as BCPolicySpec;
    validateFeatureNames(spec.featureNames);

    return {
      kind: 'json',
      label: getFilePath(file) || file.name,
      provider: new JsonPolicyAdapter(spec),
      manifest: spec,
    };
  }

  throw new Error('No compatible JSON policy file was found. Expected a file with format "bc-mlp-v1".');
}

async function loadNativeManifest(files: AnyFile[]): Promise<{ manifest: NativePolicyManifest; label: string }> {
  for (const file of files.filter(isJsonLikeFile)) {
    const parsed = await parseJsonFile(file);
    if (hasValidManifestShape(parsed)) {
      validateFeatureNames(parsed.featureNames);
      validateOutputLabels(parsed);

      return {
        manifest: parsed,
        label: getFilePath(file) || file.name,
      };
    }

    if (hasValidJsonPolicyShape(parsed)) {
      const spec = parsed as BCPolicySpec;
      return {
        manifest: convertBcPolicySpecToNativeManifest(spec),
        label: getFilePath(file) || file.name,
      };
    }
  }

  throw new Error('No native policy manifest found. Expected a JSON file with format "bc-native-v1" or a BC policy JSON file to reuse as native metadata.');
}

async function loadOnnxPolicy(files: AnyFile[]): Promise<PolicyLoadResult> {
  const modelFile = pickFileBySuffix(files, '.onnx');
  if (!modelFile) {
    throw new Error('ONNX policy loading requires a .onnx model file.');
  }

  const { manifest, label } = await loadNativeManifest(files);
  const ort = await import('onnxruntime-web');
  const ortAny = ort as any;
  const isBrowserRuntime = typeof window !== 'undefined' && typeof document !== 'undefined';
  if (isBrowserRuntime && ortAny?.env?.wasm && !ortAny.env.wasm.wasmPaths) {
    ortAny.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/dist/';
  }

  const session = await ort.InferenceSession.create(new Uint8Array(await modelFile.arrayBuffer()), {
    executionProviders: ['wasm'],
  });

  const provider = new OnnxPolicyAdapter(ortAny, session as any, manifest);
  return {
    kind: 'onnx',
    label: `${label} + ${getFilePath(modelFile) || modelFile.name}`,
    provider,
    manifest,
  };
}

async function loadTfjsPolicy(files: AnyFile[]): Promise<PolicyLoadResult> {
  const modelFile = pickFileByName(files, 'model.json') ?? pickFileByName(files, 'policy.model.json');
  if (!modelFile) {
    throw new Error('TFJS policy loading requires a model.json file.');
  }

  const { manifest, label } = await loadNativeManifest(files);
  const tf = await import('@tensorflow/tfjs');
  const modelJson = await parseJsonFile(modelFile) as {
    format?: string;
    generatedBy?: string;
    convertedBy?: string;
    modelTopology?: unknown;
    weightsManifest?: Array<{ paths?: string[]; weights?: unknown[] }>;
    trainingConfig?: unknown;
  };

  if (!modelJson || typeof modelJson !== 'object' || !modelJson.modelTopology) {
    throw new Error('TFJS model.json is missing modelTopology.');
  }

  const weightsManifest = Array.isArray(modelJson.weightsManifest) ? modelJson.weightsManifest : [];
  const weightSpecs = weightsManifest.flatMap((group) => Array.isArray(group.weights) ? group.weights : []);
  const weightBuffers: ArrayBuffer[] = [];
  const modelBaseDir = getParentDirectory(getFilePath(modelFile));

  for (const group of weightsManifest) {
    const paths = Array.isArray(group.paths) ? group.paths : [];
    for (const shardPath of paths) {
      const shardFile = resolveFileByRelativePath(files, modelBaseDir, shardPath);
      if (!shardFile) {
        throw new Error(`TFJS weight shard not found: ${shardPath}`);
      }

      weightBuffers.push(await shardFile.arrayBuffer());
    }
  }

  const ioHandler = {
    load: async () => ({
      modelTopology: modelJson.modelTopology,
      weightSpecs,
      weightData: weightBuffers.length > 0 ? concatArrayBuffers(weightBuffers) : new ArrayBuffer(0),
      format: modelJson.format,
      generatedBy: modelJson.generatedBy,
      convertedBy: modelJson.convertedBy,
      trainingConfig: modelJson.trainingConfig,
    }),
  };

  const model = await tf.loadLayersModel(ioHandler as any);
  const provider = new TfjsPolicyAdapter(tf, model, manifest);

  return {
    kind: 'tfjs',
    label: `${label} + ${getFilePath(modelFile) || modelFile.name}`,
    provider,
    manifest,
  };
}

export async function loadPolicyFromFiles(files: File[], sourceKind: PolicySourceKind = 'auto'): Promise<PolicyLoadResult> {
  const normalizedFiles = files.filter(Boolean) as AnyFile[];
  if (normalizedFiles.length === 0) {
    throw new Error('No policy files were selected.');
  }

  if (sourceKind === 'json') {
    return loadJsonPolicy(normalizedFiles);
  }

  if (sourceKind === 'onnx') {
    return loadOnnxPolicy(normalizedFiles);
  }

  if (sourceKind === 'tfjs') {
    return loadTfjsPolicy(normalizedFiles);
  }

  try {
    return await loadJsonPolicy(normalizedFiles);
  } catch {
    // fall through to native loaders
  }

  try {
    return await loadOnnxPolicy(normalizedFiles);
  } catch {
    // fall through to TFJS
  }

  return loadTfjsPolicy(normalizedFiles);
}
