# LAD 读法评测：怎么跑、怎么算分

> 对应 [`docs/lad-understanding-plan.md`](../../../docs/lad-understanding-plan.md) 阶段 7。
> 题库由 [`generate.ps1`](generate.ps1) 从知识库生成，真值来自工具本身（`ladderText` 与读写边），不由人手工写。

## 1. 生成题库

```powershell
$env:DOTNET_ROOT = "$env:USERPROFILE\.dotnet10"
pwsh -NoProfile -File scripts/eval/lad-qa/generate.ps1 `
  -Database 'C:\...\reference\knowledge\Sino_PEI\Sino_PEI_knowledge.db' `
  -Out scripts/eval/lad-qa/reference-questions.json `
  -Limit 80
```

- `condition` 题：某网络里某线圈的写入条件（可有多条 = 或关系）。含不透明步骤（`[Move]`、`[Eq]`、`[Call]`）的网络被排除，因为它的条件在别的网络里。
- `writers` 题：某变量的全部写入网络。
- 题库是**参考工程**（`Sino_PEI`）的，`-Database` 指向它的知识库。

## 2. 跑评测

评测要在**装了 `@automation-suite/engineering-graph` 的会话**里做（本仓库的验收 profile，见根 `AGENTS.md` §6）。同一模型、同一会话设置，分两组：

| 组 | 允许的工具调用 |
|---|---|
| 对照组 | `knowledge_network`（默认 `view='logic'`）+ `knowledge_block` |
| 实验组 | 同上，但 `knowledge_network(view='ladder')` + `knowledge_variable_usage` |

每组对题库逐题作答，记录：答案原文、用到的工具调用序列、token 数。

## 3. 判分

| 题型 | 判法 | 通过条件 |
|---|---|---|
| `condition` | 把答案按 `OR` 拆成多个条件串，逐条与真值集合比对（顺序无关、大小写与空格归一） | 集合完全相等 |
| `writers` | 提取答案里的 `块#网络号` 集合 | 集合完全相等 |

记录每题**是否正确**与**token 数**，最后按题型汇总正确率。

## 4. 门槛（切换默认 `view` 的依据）

| 指标 | 目标 |
|---|---|
| `condition` 正确率 | ≥ 90% |
| `writers` 正确率 | ≥ 95% |
| 每题 token | 不高于对照组 +30% |

达标后把 `knowledge_network` 的默认 `view` 从 `logic` 改为 `ladder`，并在 `packages/dsh-engineering-graph/docs/decisions.md` 记一条。

未达标时**不要**改默认值；先看错题属于哪一类：

- 结构读错（把并联当串联）→ 阶梯视图的渲染或归约有 bug，回到阶段 2/4 的用例。
- 时序读错 → `scanOrderNotes` 的规则需要补（同网络读写、跨块）。
- 变量名读错 → 符号解析问题，与视图无关。

## 5. 已知边界

- 题库只覆盖纯布尔网络（约 1/3 的线圈）。含盒指令的网络当前无法用字符串真值判分；它们的价值在阶段 4 的"不透明步骤"标注，不在本评测。
- 评测结果依赖会话里模型的工具使用习惯，跨模型不可直接比较。
- 题库从数据库生成，数据库过期（`source/` 变过但没重新 ingest）时真值会与工程不符——跑之前先确认 `knowledge_workspace` 报 `fresh`。
