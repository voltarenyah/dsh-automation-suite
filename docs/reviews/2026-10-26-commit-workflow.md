# 提交工作流复盘：`sync → diff → 读逻辑 → commit message`

> **方案已修订**：2026-10-27 的三条原则（职责边界 / diff 只到文件与元素 / 变更包交给 expert）见
> [2026-10-27-change-bundle-design.md](2026-10-27-change-bundle-design.md)。本文 §3 里
> "project_diff 输出 network 内容与 ST"的提议**不再采用**；§1–§2 的事实与根因仍然有效。

- 会话：`session-132825e0-c92a-4439-855a-88e7f1f85efa`（leader，preset `leader`）
- 子会话：`96546fd2…`（auditor）、`0849b3f9…`（expert）
- 工作区：`C:\Users\Ansel\Documents\dsh-automation-suite\SWT2_PEI_1026_Night`
- 发行版 home：`C:\Users\Ansel\dsh-automation-suite-home`（profile `dsh-automation-suite-v0.1.4`）
- 涉及提交：`17f21d4a`（基线）→ `a5f84d5d`（逻辑改动）→ `e331d6e1`（注释改动）
- 本文只做复盘与方案；**没有改动任何代码**。

---

## 0. 一句话结论

这次暴露的三个问题都是**结构性错位**，不是模型能力问题：

1. `project_diff` 已经解析出"改了什么内容"，但渲染层只吐计数（`diff.ts` 的 `blockDetailLines`）。
2. network 的身份用 TIA 的位置性 CompileUnit ID，插一个 network 让后面 9 个全部"被修改"，
   报告里的 `3C parts 23→7` 是**错的语义**。
3. "读懂逻辑"被接到了"刷新 671 MB 图谱"这条重链上；正确接法是"差异内容 + 不落库的翻译"。

三处都能修，P0 部分改动很小。

---

## 1. 事实基线

### 1.1 时间线（本机时间，Asia/Shanghai）

| 时间 | 事件 | 耗时 |
|---|---|---|
| 22:17:27 | 用户发起：TIA 侧改了东西，想知道改了什么 + 草拟 commit | — |
| 22:17:52 | leader 派 auditor（sync + diff + 草拟） | — |
| 22:20:44 | auditor 回报：1 个块，units 13→14，+1/−0/~10，**无内容** | ≈2 min 50 s |
| 22:20:44 | 用户选「Hold，先刷图谱再读新网络」 | — |
| 22:24:13 | auditor 跑 `knowledge_update`（单路径） | 58 s 引擎 / 71 s 墙钟 |
| 22:26:43 | leader 派 expert | — |
| 22:31:40 | expert 返回完整逻辑描述 | 5 min 17 s（**317 s，40 次工具调用**） |
| ≈22:33 | 用户批准 commit → auditor 提交 a5f84d5d | ≈50 s |
| 22:34–22:37 | leader 导出 N4 XML、填注释、导入、编译 | ≈50 s TIA 操作 |
| 22:39:43 | 用户批准 commit #2 → e331d6e1 | ≈50 s |
| 22:49–22:50 | 保存并关闭 TIA | ≈25 s |

总墙钟约 **33 分钟**；其中真正"理解改动"占 **7.5 分钟**，且有 **2 次额外的用户往返**。

### 1.2 工具耗时结构（来自会话事件时间戳）

| 角色 | 墙钟 | 工具总耗时 | 工具调用数 | 说明 |
|---|---|---|---|---|
| auditor | 1469 s（含等待） | 371 s | 44 | `project_sync` 183 s、`project_status` 72 s、`knowledge_update` 58 s、`project_commit` 50 s、`project_diff` 7.7 s |
| expert | 317 s | **3 s** | 40 | 工具几乎不耗时，**5 分钟全是 40 次 LLM 往返** |

结论：expert 慢在"问题太宽 + 事实不全，自己探索"，不在工具。

### 1.3 这次改动的真实语义（我用 git 对象直接核对）

旧（`17f21d4a`）与新（`a5f84d5d`）的 `100_Cycle_Selection_Cav_A.xml`，
按 CompileUnit ID 列：

| 位置 | 旧 ID / parts / 标题 | 新 ID / parts / 标题 | 真实语义 |
|---|---|---|---|
| 4 | `3C` 23 / **Full cycle request** | `3C` 7 / **（无标题）** | **新插入的 network**（写 `CoolingTableBlocked`） |
| 5 | `4D` 5 / Cavity wait green… | `4D` 24 / **Full cycle request** | 原 `3C` 后移一位，**+1 part**（新增 `NOT CoolingTableBlocked` 触点） |
| 6–14 | `5E…D5` | `5E…E6` | 内容未变（parts/wires/accesses 与标题一致），只是 ID 平移 |

即：**插入 1 个 network + 修改 1 个 network + 9 个 ID 平移**。
`project_diff` 报成 `+1/−0/~10`，并把"插入的新网络"与"被后移的 Full cycle request"对比，
得出 `3C parts 23→7` —— 这是把两个不同 network 当成同一个在比。

### 1.4 图谱刷新的真实成本

`knowledge_update` 对 `blocks/01_Cavity_A/100_Cycle_Selection_Cav_A.xml` 单路径刷新：

- 第一次被拒：`UPDATE_TOO_LARGE` —— 112 个组件（1 changed + **111 闭包**），默认上限 50；
- 提高 `max_components=200` 后成功：58.4 s，库 671.4 MB → **692.0 MB**；
- 闭包来源是引擎设计（`IncrementalGraphUpdate.FindInboundOwners`）：**所有指向该组件节点的边所属组件**都要重导，
  否则邻居的边会随节点删除而 CASCADE 消失。

所以对这个被大量调用的 FC，"单路径增量刷新"名不副实：它是 **112 个组件的重导**。
文件涨 20 MB 主要是 SQLite 页复用（删除旧节点后空闲页不回收），不是新增了 20 MB 语义数据（推断，未单独验证）。

---

## 2. 根因

### R1 `project_diff` 有内容，只渲染计数（P0，最小改动）

`packages/dsh-engineering-context/src/diff.ts` 里数据已经齐了：

| 已有数据 | 位置 | 当前渲染 |
|---|---|---|
| `units.added.items[].label`（network 标题） | `diff.ts:916` | 只印 `+1` |
| `interface.added.items[]`（section + name + datatype） | `diff.ts:925` | 只印 `interface +1` |
| `text.added/removed.items[]`（owner + culture + text 全文） | `diff.ts:932` | 只印 `text +18/−18` |
| `units.changed.items[0]` 的 parts/wires/accesses | `diff.ts:952` | 只印**第一个** |

`blockDetailLines`（`diff.ts:1426-1459`）把这些全部压成一行
`units 13→14; +1/-0/~10; changed unit 3C: …; interface +1/-0/~0; text +18/-18; faces: …`。

后果：auditor 只能写 `extend … by one network`（猜），leader 只有去 `pwsh` 抓 XML 才能拿到名字。

### R2 unit 身份是位置性 ID（P0，语义正确性）

`compareUnits`（`diff.ts:937-971`）按 `unit.key`（TIA CompileUnit ID）匹配。
本工程 LAD 块的 CompileUnit ID 是**位置性**的（`9,1A,2B,3C,…`，每次插入整体后移），
于是一次插入被摊成 10 个 changed。

这不是显示问题：它直接污染了 auditor 的报告、leader 的 brief、expert 的推理
（expert 花了约 1/4 的篇幅才自己发现"positional ids"）。

### R3 交接契约：让 auditor 草拟 message，但它只有计数

`profile/dsh-automation-suite/cordis.patch.yml` 的 `preset-auditor` 明确要求
"Write the commit message yourself from what the diff shows"（约 483-492 行），
而它的 `project_diff` 只给计数 —— 于是产出必然是"数字翻译成英文"。
leader 随后又用 expert 的结论推翻它，等于同一条 message 写了两遍。

### R4 把"读逻辑"接到了"刷新图谱"

产品默认其实**不**刷新（`project_sync` 的 `refresh_knowledge` 默认 false，`sync.ts:44-51`）。
这次是流程选择：leader 认为"expert 要读新 network，就得先有新图谱"。
但图谱是**当前快照**，它不承载 comment 文本（expert 明确报告 `+18/-18` 无法枚举）、
不承载 block header comment、也没有旧版本。为一个新增 network 重导 112 个组件不划算。

### R5 权能与规则错位 → `pwsh` 绕行

| 角色 | 有 | 政策 | 实际 |
|---|---|---|---|
| leader | `pwsh`、`git_diff`、TIA 全量 | "Do not read the exported XML, and do not grep/glob over `source/`"（187-190 行） | 用 `pwsh` + `git diff \| Select-String` 抓 XML；一次 `ParserError`；`export_blocks` 到 `.dsh/tmp` 再解析 |
| expert | `read`/`glob`/`grep` | "Do not read the exported XML … ask the user first"（649-657 行） | 子 agent 的 `ask_user_question` 无 answerer → 结构上不可能获批；只能由 leader 转述 XML 片段（= leader 替它读了） |

`.gitignore` 只忽略 `.dsh/local/`，所以 `.dsh/tmp/`、`.dsh/notes/` 变成 untracked（turn 7 的 `git_status` 显示 `untracked: .dsh/`），
最后还要问用户删不删。

---

## 3. 优化方案

### P0 — 半天内可做，纯渲染与文案

#### P0-1 `project_diff` 输出内容级明细

在 `blockDetailLines` 之外增加"内容行"（受 `max_items` 限制，超出的报计数）：

```text
100_Cycle_Selection_Cav_A (FC, blocks/01_Cavity_A, modified); units 13→14 (+1 inserted at 4, ~9 renumbered); faces: Code, Comments, Interface
  + network 4 (id 3C, no title): 7 parts / 13 wires / 6 accesses
  ~ network 5 (id 4D, "Full cycle request"): parts +1 (24 vs 23)
  interface + Temp.CoolingTableBlocked : Bool
  text + [Title en-GB] "Cooling table blocked"; + [Comment fr-FR] "…"; − [Title en-GB] "" …
```

实现要点：

- 数据不用改，只改渲染：`units.added/removed/changed`、`interface.added/removed/changed`、`text.added/removed`；
- 每条文本截断到 ~160 字符，避免 token 爆炸；总行数仍受 `outcome.ts` 的 `MAX_DETAIL_LINES=40` 约束；
- 加参数 `detail: 'summary' | 'content'`（默认 `content`，因为这次的问题就是默认太省）；
- **验收**：用 `17f21d4a..a5f84d5d` 回放，输出必须出现
  `CoolingTableBlocked`、新增 network 的标题（空）、`Full cycle request` 的 +1 part、四条文本内容。

#### P0-2 unit 内容对齐，消除 ID 平移造成的假变更

`compareUnits` 改为两段式：

1. 先按 `key`（ID）匹配"位置未变"的 unit；
2. 未匹配的，用**内容指纹**对齐（`label` + parts/wires/accesses + NetworkSource 的哈希），
   识别出"插入/删除 + 平移"，输出 `alignment: { insertedAt, inserted: n, removed: n, renumbered: n }`，
   且 `changed` 里不再包含纯平移的 unit。

- 更稳的做法是对旧/新序列做 LCS（以内容指纹为相等判据），得到 insert/delete 事件；
- `UnitChange` 增加 `alignment: 'inserted' | 'removed' | 'modified'`；
- **验收**：本次回放输出 `inserted at position 4; modified: "Full cycle request" (+1 part); renumbered: 9`，
  `changed` 数为 1，而不是 10。

#### P0-3 交接契约：auditor 只给"清单 + 差异"，message 由 leader 合成

新链路（三处 persona 改动）：

```text
leader   → auditor : sync + project_diff(detail:"content")，只要清单与差异，不写 message
auditor  → leader  : { changedBlocks[], perBlockDiff, graphFreshness, refreshVerdict }
leader   → expert  : 上述 payload + "旧图谱是 stale，这是差异内容；请给意图与影响"
expert   → leader  : { intent, affectedNetworks, risks, coverage }
leader   → 用户    : 一份 commit message + 确认
```

改动点：

- `preset-auditor` 的 suffix：删掉"你自己写 message"，改为"输出变更清单 + 每块的差异内容（network/interface/text），
  以及对是否需要刷新图谱的判定；不要解释逻辑、不要写 commit message"；
- `preset-leader` 的 Delegation policy：加一条"用户要求草拟提交信息时，必须先取 auditor 的差异内容，
  再交给 expert 解析意图，最后自己合成；不要在 auditor 只有计数时就写 message"；
- `preset-expert`：brief 里必须带"改动块清单 + 差异内容"，expert 不再被要求"自己找改了哪个 network"。

#### P0-4 堵住 `pwsh` 绕行，清理工作区污染

- leader 的 persona 加硬规则：**禁止**用 `pwsh`/`bash` 解析 `source/`、`.dsh/tmp/` 下的 XML；
  需要内容就调 `project_diff(detail:"content")`，或由 auditor/expert 的工具输出；
  （若要工具级保证，可在 `dsh-tool-pwsh` 的 config 里对 `source/**/*.xml` 做写/读守卫，成本更高，可选。）
- `create_engineering_project` 写的 `.gitignore` 增加 `.dsh/`（至少 `.dsh/tmp/` 与 `.dsh/notes/`），
  不再让临时导出物变成 untracked；
- turn 7 暴露的 `project_status` 在"无打开项目"时报告 `not a repository / no device`，
  建议改成明确的 `no open project — device cannot be resolved (reopen first)`，避免误导。

### P1 — 1~2 天

#### P1-1 新增"不落库翻译"能力（本方案的关键）

引擎已经有可直接复用的入口：

```csharp
// engine/Parsing/ProgramBlockLogicYamlWriter.cs:53
public static IReadOnlyDictionary<string, NetworkLogic> GetNetworkLogicBySegmentKey(string xml, ProgramBlockComponent component)
```

它只吃 XML 字符串 + `ProgramBlockComponent`，**不需要数据库**。所以新增一个引擎 op：

```text
translateBlocks({ files: [{ path, name, category }], networkFilter?: string[] })
  → [{ path, networks: [{ index, compileUnitId, title, language, statements }] }]
```

- 不写库、不碰 TIA、秒级；
- 在 `dsh-engineering-context` 的 `project_diff(detail:"translate")` 里调用，
  对每个 **added/changed** unit 给出"改前/改后 ST"，并对 changed 做语句级 diff（`+`/`−` 行）；
- 这样 expert 拿到的就是用户要的：
  `新增 network 4（无标题）→ CoolingTableBlocked := …`，
  `network 5 → 两个 OR 项各多一个 AND NOT CoolingTableBlocked`；
- **验收**：本次回放，`project_diff` 直接给出 `CoolingTableBlocked := (((Cured_Jib AND …` 的 ST，
  与 expert 当时从图谱读到的文本一致（可比对）。

#### P1-2 刷新策略：默认不刷新，给出判据

| 改动类型 | 需要刷新图谱？ | 理由 |
|---|---|---|
| 新增/删除/改名 block、block 分组变化 | **是** | 节点标识/路径变了，旧库答不对 |
| 修改已有 network 的逻辑 | 否 | 差异 + 翻译足够；旧图谱提供上下文 |
| 新增 network（不涉及跨块调用） | 否 | 翻译工具直接给 ST |
| 接口成员增删（块内局部量） | 否 | 差异给名字/类型；跨块影响用旧图谱 + diff 判断 |
| PLC 类型 / 变量表 / UDT 变更 | **是** | 影响面是全库 |
| 需要"最新"的 CALLS/READS 边（新增/删除跨块调用） | 是（或至少重导相关块） | 边变了，旧图答错 |

配套：`knowledge_update` 的 `UPDATE_TOO_LARGE` 拒绝后，工具结果里直接给出
"这是 112 组件闭包，预计 58 s、库 +20 MB；如果你只是想读这个 network 的新逻辑，用 `project_diff(detail:"translate")` 不必刷新"。
（当前是拒绝 → 人工加 `max_components` 重试，多一次往返。）

#### P1-3 expert 的输入与工具面

- brief 必带：改动块清单、每块差异（含 ST diff）、`graph built at <checksum>（stale，相对于 source 的区别）`、
  "不要重新推导这些事实"；
- expert 的工具面保持"只读图谱 + 差异工具"，**不**开放 `source/` 全量读权（会上下文爆炸，且政策失效）；
- 目标：本次这类问题 expert 的往返从 40 次降到 ~8 次、5 分钟降到 ~2 分钟（可测）。

#### P1-4 `project_diff` 与 `project_commit` 的措辞

- `project_commit` 的 `pending.suggestedMessage` 目前是 `sync: … 1 changed` 这类生成句；
  建议在审计流程里默认不展示它，避免模型拿它当草稿；
- `project_diff` 的 description 明确写"counts + entries；用 detail:'content' 取每块的内容差异"，减少模型误用。

### P2 — 3~5 天，可选

- **P2-1 图谱携带"上一版快照"**：`knowledge_networks` 增加 `prev_logic_statements` / `prev_title`
  （或一张 `network_revisions` 表），让"stale 图谱 + 上一版翻译"本身就能回答"改了什么"，
  但这会显著增加库体积，收益与刷新成本要权衡。
- **P2-2 注释入图**：当前图谱不承载 block header comment 与多语言注释全文，
  所以 `text +18/−18` 无法归类到具体 network。若要做"提交信息里写清楚注释改了什么"，需要把
  `MultilingualText` 的 owner + culture + text 入图（至少 network 级）。
- **P2-3 回归 fixture**：把本次 `17f21d4a..a5f84d5d` 这一对 XML 做成
  `project_diff` 的固定样例（期望：inserted 1 / modified 1 / renumbered 9 / 4 条文本 / 1 个成员 / 1 段 ST），
  以后改 diff 逻辑先跑它。

---

## 4. 目标工作流（改后）

```text
用户：我在 TIA 改了东西，想知道改了什么并给我提交信息
  │
  ├─ leader → auditor：project_sync(dry_run:false) + project_diff(from=HEAD, to=WORKTREE, detail:"content")
  │     auditor 返回：changedBlocks[] + 每块 units/interface/text 差异 + 新增/修改 network 的 ST diff
  │                   + graphFreshness + refreshVerdict（"这类改动不需要刷新"）
  │
  ├─ leader → expert：上述 payload + "旧图谱 stale；请给意图、影响、风险"
  │     expert 返回：intent + affected + risks + coverage（2 分钟内）
  │
  ├─ leader → 用户：一份 commit message（已含意图）+ 确认
  └─ 用户确认 → leader → auditor：project_commit(dry_run → false)
```

对比这次：少一次用户往返（不再"先 Hold 再刷新再读"）、少 58 s 刷新、少 20 MB 库增长、
少 40 次 expert 探索、少 3 条 `pwsh` 绕行。

---

## 5. 验收清单（以本次为回放样例）

| # | 断言 | 现状 | 目标 |
|---|---|---|---|
| 1 | `project_diff` 输出新增 network 的 ID/标题/parts | 只有 `+1` | `+ network 4 (3C, no title)` |
| 2 | 输出 interface 成员名与类型 | 只有 `+1` | `+ Temp.CoolingTableBlocked : Bool` |
| 3 | 输出文本差异内容 | 只有 `+18/−18` | 四条 title/comment 原文 |
| 4 | 输出新增/修改 network 的 ST | 无 | `CoolingTableBlocked := …` |
| 5 | 假变更数 | 9（renumbered 被算 changed） | 0（`inserted 1 / modified 1 / renumbered 9`） |
| 6 | 图谱刷新次数 | 1（58 s，+20 MB） | 0（除非判据表命中） |
| 7 | `pwsh` 解析 XML 次数 | 3 | 0 |
| 8 | 用户确认次数 | 2（Hold + 批准） | 1（批准） |
| 9 | 从发起到拿到 message | ≈14 min（22:17→22:31） | ≤ 7 min |
| 10 | expert 工具往返 | 40 | ≤ 10 |

---

## 6. 不建议做的事

- **不要**让 auditor 读 XML 解释逻辑（越权，且它没有编译/写能力）。
- **不要**为了读一个 network 做全量 ingest 或设备级 rebuild。
- **不要**把"刷新图谱"当作"保证 commit message 正确"的手段；图谱是当前快照，不承载旧版本。
- **不要**给 expert 开 `source/` 全量读权；用工具产出的差异/翻译片段喂它。
- **不要**在 leader 里用 `pwsh` 重新实现 `project_diff` 已经能做的事。

---

## 7. 待你决定

1. **P0-1 默认值**：`project_diff` 的 `detail` 默认 `content`（信息全，token 多）还是 `summary`（省，但这次的问题会重现）？
2. **翻译工具的归属**：放在 `dsh-engineering-graph`（引擎侧新增 op，`knowledge_translate`）还是
   `dsh-engineering-context`（`project_diff(detail:"translate")` 内部调 graph 服务）？
3. **P0-2 对齐算法**：LCS（更准，代码多一点）还是"指纹 + 位置扫描"（够用，代码少）？
4. **auditor 是否保留草拟 message 的能力**：保留为 fallback（当 expert 不可用时），还是彻底删掉（强制走 leader 合成）？
5. **`.dsh/` 是否全量忽略**：忽略整个目录会连 `.dsh/notes/`（本次的笔记）一起丢掉版本控制机会；
   只忽略 `.dsh/tmp/` 与 `.dsh/local/` 更保守。

---

## 附录 A：证据位置

| 事实 | 出处 |
|---|---|
| diff 只渲染计数 | `packages/dsh-engineering-context/src/diff.ts:1426-1459` |
| 数据已含标题/成员/文本 | `diff.ts:904-934` |
| 按 ID 匹配导致级联 | `diff.ts:937-971` |
| 工具描述"returns bounded counts … instead of XML" | `src/tools/diff.ts:69-76` |
| 详情行上限 40 | `src/tools/outcome.ts:36` |
| `refresh_knowledge` 默认 false | `src/tools/sync.ts:44-51` |
| 增量刷新上限 20 文件 | `src/knowledge-refresh.ts:28` |
| 闭包 = 入边所有者 | `engine/Graph/IncrementalGraphUpdate.cs:316-358` |
| 默认 maxComponents 50 | `engine/Graph/IncrementalGraphUpdate.cs:56` |
| 可复用的翻译入口 | `engine/Parsing/ProgramBlockLogicYamlWriter.cs:53` |
| auditor 被要求自己写 message | `profile/dsh-automation-suite/cordis.patch.yml:483-492` |
| leader 禁止读 XML | 同上 `:187-190` |
| expert 禁止读 XML + 子 agent 无 answerer | 同上 `:649-657` |
| `.gitignore` 只忽略 `.dsh/local/` | 工作区 `.gitignore` |

## 附录 B：本次 CompileUnit 序列（供 P0-2 回归用）

```text
old (13): 9(6/11/5) 1A(12/22/10) 2B(8/16/8) 3C(23/44/21 "Full cycle request")
          4D(5/9/4) 5E(8/19/10) 6F(23/41/19) 80(7/14/7) 91(26/49/23)
          A2(15/29/15) B3(17/45/32) C4(17/32/17) D5(7/13/7)
new (14): 9 1A 2B 3C(7/13/6, 无标题, 写 CoolingTableBlocked)
          4D(24/46/22 "Full cycle request" = 旧 3C +1 part)
          5E(5/9/4) 6F(8/19/10) 80(23/41/19) 91(7/14/7) A2(26/49/23)
          B3(15/29/15) C4(17/45/32) D5(17/32/17) E6(7/13/7)
```
