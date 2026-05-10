# 现代 STG / 弹幕游戏 AI 训练方式调研

## 结论

目前更常见、也更适合落地的路线，不是直接端到端吃像素，而是先做结构化观测，再用行为克隆、self-play 和强化学习逐步提升。

对于弹幕游戏来说，最稳的主流组合通常是：

1. 结构化状态输入。
2. 行为克隆预热。
3. Self-play / league self-play 微调。
4. PPO、DQN、actor-critic 等强化学习方法继续优化。
5. 必要时再叠加 CMA-ES、PBT、NEAT 这类搜索/进化方法。

## 目前常见的实现路线

### 1. 结构化观测优先于原始像素

对 bullet hell / STG 来说，公开项目和论文里最常见的做法，是把环境拆成可解释特征：

- 玩家位置、血量、炸弹、速度、是否蓄力。
- 子弹的相对位置、速度、类别、是否激光/警告弹。
- 敌机 / Boss 的位置、血量、阶段状态。
- 历史动作和历史威胁值。

这样做的原因很直接：

- 比像素更容易学。
- 更容易调试。
- 更适合弹幕这种信息密度高但语义很清晰的场景。

### 2. 先用行为克隆做 warm-start

行为克隆（Behavior Cloning, BC）本质上就是监督学习：把专家或人类的状态-动作对当标签，先训练一个能“像样地玩”的初始策略。

在游戏 AI 里，这个路线特别常见，因为它能解决两个问题：

- RL 一开始太弱，数据效率很差。
- 弹幕游戏奖励稀疏，纯 RL 很容易学歪。

对 STG 来说，BC 往往先学：

- 基本移动方向。
- 是否停火。
- 何时开技能/炸弹。

### 3. Self-play 是对抗类游戏的核心手段之一

Hugging Face 的 deep RL 教程和自对弈综述都把 self-play 视为对抗式游戏训练的经典手段。它的基本思想是：

- 让智能体和自己对打。
- 或和历史版本、不同风格的对手对打。
- 避免策略只会针对单一脚本或单一对手。

对 STG / 弹幕对战尤其有价值，因为这种游戏天然是对抗结构，单一固定对手很容易被“刷穿”。

### 4. PPO / actor-critic 仍然是最常见的通用方案

如果你希望训练稳定、方便扩展，多数现代项目会把 PPO 或 actor-critic 类方法作为主训练器。

原因是：

- 连续/离散动作都能处理。
- 训练相对稳定。
- 可以和 self-play、奖励 shaping、动作 mask 配合。

### 5. DQN 仍适合离散动作明显的弹幕环境

近年的 bullet hell 论文和项目里，DQN 仍然很常见，尤其是在动作空间比较明确的时候。

一个典型模式是：

- 用 ray casting 或局部威胁扫描代替像素。
- 输入给 DQN / Double DQN / dueling DQN。
- 输出离散动作，比如 8 方向移动、停火、开火、炸弹。

这类方法的优点是简单直接，适合动作集合比较小的 STG。

### 6. 搜索/进化方法仍然很实用

在弹幕游戏里，很多时候最难的不是模型结构，而是奖励设计和调参。所以 CMA-ES、OpenAI-ES、PBT、NEAT 仍然是很常见的补充方案。

它们特别适合：

- 直接调规则 AI 权重。
- 直接调威胁函数、边角惩罚、炸弹阈值。
- 直接搜一个可解释 baseline 的参数。

## 论文/项目里常见的具体做法

### 1. Bullet hell 环境 + RL

GitHub 上的 `bulletrl` 这类环境，思路就是把 Touhou-like bullet hell 包成 OpenAI Gym 环境，然后喂给强化学习算法训练。

这种项目的共同点是：

- 自定义环境接口。
- 状态是抽象特征，不是纯像素。
- 训练和评估都比较依赖脚本化环境。

### 2. DQN + ray casting

2024 年的 ACM 论文摘要里，明确提到他们用 DQN 训练 bullet hell AI，并用 ray casting 收集输入数据。这个做法很有代表性：

- ray casting 负责把周围威胁压成一组可学习特征。
- DQN 负责学离散动作决策。

这类方案非常适合“躲弹 + 少量按钮动作”的 STG。

### 3. 行为克隆 + self-play + PPO 的组合

2024 到 2025 年的研究和教程都在强化同一个趋势：

- 先 BC。
- 再 self-play。
- 再 PPO 或类似 actor-critic 微调。

这不是偶然，而是因为纯 RL 在对抗游戏里常常收敛慢、方差大。

### 4. 结构化状态 + 动作掩码

在弹幕游戏里，动作掩码几乎是刚需：

- 技能冷却时屏蔽技能头。
- 已经贴边时弱化明显越界方向。
- 能量不足时屏蔽不合法技能。

这能显著减少无效动作和训练噪声。

## 推荐的训练管线

如果目标是“做一个现在就能打”的 STG AI，比较稳的顺序是：

1. 先做结构化环境和日志。
2. 用人类或规则 AI 数据做 BC warm-start。
3. 用 PPO / actor-critic 做 self-play 微调。
4. 引入 league 对手，防止策略坍塌。
5. 再用 CMA-ES / PBT / NEAT 调策略权重或超参数。

如果目标是“先出一个可解释 baseline”，则更建议：

1. 手工规则策略。
2. BC 模仿规则策略。
3. 再用 RL 继续优化。

## 对当前项目最有用的映射

结合这个仓库的现状，最容易落地的是下面这套：

- 状态：玩家 / 敌机 / 子弹 / Boss / 历史动作 / 威胁值。
- 动作：移动 9 方向、开火开关、技能头。
- 训练：先 BC，再 self-play PPO。
- 调参：再用 CMA-ES 或 PBT 调威胁权重、边角惩罚、炸弹阈值。

这和现代 STG AI 的主流思路是一致的，也和 PoDD 那种“先规则 baseline，再慢慢进化”的路线兼容。

## 资料来源

- [Simple bullet hell environment for reinforcement learning](https://github.com/khang06/bulletrl)
- [Artificial Intelligent Player for Bullet Hell Games Based on Deep Q-Networks](https://dl.acm.org/doi/10.1145/3650215.3650381)
- [Designing an AI Agent for Touhou-Style Bullet Hell Games](https://fujisaki.top/2025/06/08/designing-an-ai-agent-for-touhou-style-bullet-hell-games/)
- [Self-Play: a classic technique to train competitive agents](https://huggingface.co/learn/deep-rl-course/unit7/self-play)
- [A Survey on Self-play Methods in Reinforcement Learning](https://nicsefc.ee.tsinghua.edu.cn/nics_file/pdf/db43f779-dd0e-4f2e-a51c-1caa107e21eb.pdf)
- [Ch. 21 - Imitation Learning](https://underactuated.mit.edu/imitation.html)
