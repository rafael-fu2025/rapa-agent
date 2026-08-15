# 采用 dsh 风格的架构备注制度

状态：已实施
日期：2026-08-15
范围：流程

## 背景

Recreate UI 的「agentic harness」（位于 `server/src/lib/agent/` 下
的 Fastify 后端）已经扩展到 25 个职责单一的模块，但目前还没有一
种正式的方式来记录架构决策。现有的 `AGENTS.md` 描述的是「代码是
什么」，而不是「代码为什么是这样」或「考虑过哪些替代方案」。

如果没有 ADR 记录，每一个贡献者（人或智能体）都会反复踩同样的
坑：

1. **上下文丢失。** 半年后，`agent-loop.ts` 选择 `turn/step` 而
   不是 `iteration` 的理由会完全丢失。
2. **反复重新讨论。** 类似「不要整体引入 Cordis」「不做 100%
   覆盖率门槛」这样的决策，每次都会被从头再吵一遍。
3. **没有否决的真相。** 说「我们考虑过 X」如果没有书面记录，意
   味着同样的提议会反复出现在每次评审里。

DeepSeek 的 `dsh` 项目用 `.agents/notes/` 解决了这个问题——一个分
区的 ADR 目录，包含 `implemented/`、`proposed/`、`rejected/` 三
种状态，并附带双语制度。我们采用这个模式。

## 决策

在仓库根目录建立 `.agents/notes/`，分为三个分区
（`implemented/`、`proposed/`、`rejected/`），每个分区再细分为
`architecture/`、`feature/`、`process/`、`simplification/`、
`testing/`。

每个 **非平凡** 的变更必须在同一个 PR 中附带 ADR。当笔记的
`Scope` 为 `architecture` 或 `process` 且影响公开接口时，必须配
套一份 `.zh.md` 镜像。`.agents/notes/README.md` 中定义了触发条件、
格式与生命周期。

权威参考是 `C:\Users\Rafael\deepseek-harness\.agents/notes/`；
我们沿用相同的形式，但采用更轻量的双语规则（见 README 中的
「Bilingual discipline」），适配个人单机单用户部署的现实。

## 影响

**更容易：**

- 架构意图能够跨会话、跨贡献者保留下来。
- 被否决的选项留下墓碑——「我们早就考虑过 X」只需一行查询，而
  不是重新争论。
- 未来的智能体（包括本助手）可以按时间倒序阅读笔记来快速理解
  架构。

**更困难：**

- 每个非平凡变更都需要额外写一个文件。时间成本：每个备注 15–30
  分钟。这是我们为制度付出的代价。
- 评审者需要确认笔记存在、分区正确、格式合规。

**后续工作：**

- 增加 CI 检查（`scripts/check-adr.sh`），当
  `server/src/lib/agent/**` 或 `server/prisma/schema.prisma` 发生
  变更但没有对应笔记时让构建失败。
- 给 `rejected/` 分区预先写入几个我们 *实际* 非正式讨论过的决策
  （例如「不整体引入 Cordis」「不做 100% 覆盖率门槛」）。后续阶
  段会再补充。

## 替代方案

- **仓库内 Wiki（如 `docs/adr/`）。** 否决理由：Wiki 容易腐烂；
  Git 跟踪的 ADR 能跟着代码存活，并且可被 grep。
- **只用 Issue 跟踪器记录 ADR。** 否决理由：从被影响的代码中无
  法 grep 出来；评审者也无法强制同地提交。
- **不写笔记，只把 `AGENTS.md` 写得更好。** 否决理由：
  `AGENTS.md` 描述 *当前状态*；ADR 是 *决策历史*，两者职责不同。