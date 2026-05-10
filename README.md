# 飞机大战

这是一个可运行的人机对战飞机大战项目，已经接上了无头训练、行为克隆数据导出和可复用的 JSON policy 推理层。

## 训练流程

1. 用 headless 或 batch 先生成训练日志。
2. 用 `scripts/prepare_bc_dataset.py` 把原始 JSONL 转成 BC 数据集。
3. 用 `scripts/train_bc.py` 训练并导出 `policy.json`。
4. 在游戏里通过策略文件加载，把模型当作 AI 使用。

## 常用命令

```bash
pnpm build
pnpm run headless -- --episodes 10 --output-dir training-output --format jsonl --split rare-full
pnpm run evolve -- --generations 5 --population 8 --episodes 3 --output-dir evolution-output --format jsonl --split rare-full
python scripts/prepare_bc_dataset.py --input training-output --output-dir bc-dataset
python scripts/train_bc.py --dataset-dir bc-dataset --output-dir bc-model
pnpm run policy:smoke -- --policy bc-model/policy.json
```

## 人机复用

`bc-model/policy.json` 是游戏运行时可加载的策略文件。把它传给 `GameConfig.agentPolicies`，或者在浏览器开始菜单里选中 policy 文件，就可以让 AIController 使用训练好的模型。"# PPoDD" 
