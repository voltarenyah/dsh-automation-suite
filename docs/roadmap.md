# 路线图与现状

> 本文按 [目标架构](architecture.md) 的**接口插件族与两个工程插件**逐项记录进度：哪些已经在跑、哪些还没有、
> 缺口在哪、每一项的验收口径是什么。
>
> **这是方向性说明，不是承诺。** 状态一律以仓内可核对的代码、测试与实测记录为准；
> 未实现的能力在这里一律标为规划中，不要在别处当成既成事实引用。

状态图例：✅ 已实现并验证 ｜ 🟡 部分实现（有明确缺口）｜ ⬜ 未开始

---

## 1. 总览

| 名称 | 对应层 | 状态 | 落地位置 |
|---|---|---|---|
| 工控软件接口插件族（软件版本：V17/V18…；能力不拆包，由 preset 装配，D31） | ① 接入层 | 🟡 已有 **V17** 成员 | `packages/dsh-tia-openness-v17-min` |
| 工程上下文插件 | 作用域（横向） | 🟡 **部分实现**（`create_engineering_project` 一个工具：把 TIA 打开的工程另存进 workspace + 重建源文件树 + 经【缝 B】逐设备触发图谱建库；**已登记进蓝图**。P0 的注册表与 P1 的版本层已删除，见该包 D22、图谱这一步见 D25） | `packages/dsh-engineering-context` |
| 工程知识图谱插件 | ② 语义层 | 🟡 **部分实现**（引擎 + 协议 + 8 个工具 + `knowledgeGraph` 服务；**已登记进蓝图**，并被族 2 的工作流调用） | `packages/dsh-engineering-graph` |

> 插件不再编号；**只有接口插件族是"一族多成员"**。编号只保留给层（① 接入层 / ② 语义层 /
> ③ 管理与协作层，见 [`vision.md`](vision.md) §3）。

```
接口插件族 ────素材───▶ 工程知识图谱插件 ──语义──┐
   🟡 V17（基础能力）       ⬜ 可离线开发           ├──▶ 会话中有用的工程上下文
   ⬜ V17 更多能力（在线/硬件）                    │
   ⬜ V18+ 同轴                                │
        ▲                                      │
        └──────────── 工程上下文插件 ──────────┘
                        🟡 P0 作用域+注册表
```

---

## 2. 接口插件族 · 工控软件接口插件 🟡

**职责**：与工控软件对接，读写工程对象；为后续分析提供**素材**与**验证工具**。
**期望**：TIA Openness manual 暴露的能力与接口整体变成 LLM 的能力范围 —— 且**光暴露接口不算达成**，
模型还必须能通过**插件附带的文档**搞清楚"何时调用 / 怎么调用 / 调用后的数据怎么用"。

### 两条推进轴

| 轴 | 取值 | 现状 |
|---|---|---|
| **软件版本** | V17 / V18+ / … | 🟡 只做 V17；第二个版本到来时抽 core 包（[`decisions.md`](decisions.md) D3） |
| **能力装配** | 基础 → 在线 → 硬件组态 → … | 🟡 起手只有基础能力；新能力写在同一包里，按行/配置由 preset 装配（D31） |

**划分依据已定（D1）**：按**能力范围** —— 读写性质（只读 / 带回写）、对象域（硬件 / 软件）、
连接状态（离线 / 在线）、覆盖范围（PLC only / 含 HMI）、工程结构（软件单元 / 多用户 / 项目库 / 全局库）。
**每个能力具体囊括什么，日后再详细定义**；**不拆包**，能力由 preset 装配
（D31，取代 D2 的"一档一个包"）。

现有的 `dsh-tia-openness-v17-min` = **V17 基础能力**，定位是"验证基础功能"，**不是终点**。
（v0.2 已把覆盖面推到手册的三个章节 —— 按 D1 的口径，这是在基础能力上**加宽**，装配方式没有变。）

### 已实现（V17 基础能力，有实测记录）

> **v0.2（2026-10-13）把覆盖面推到了手册的三个章节**：工程与工程数据、PLC 设备数据、F 相关
> Openness。新增的 20 个操作已实现、编译、单测通过、覆盖矩阵已更新，但**尚未在真实项目上验证**
> （逐条测试项与方法见 `packages/dsh-tia-openness-v17-min/docs/VERIFICATION-PLAN.md`）。
> 下表中标 ⏳ 的行属于 v0.2 的**未验证**部分。

| 能力 | 状态 | 证据 |
|---|---|---|
| 打开/关闭 TIA V17 项目，附加到已运行实例 | ✅ | `packages/dsh-tia-openness-v17-min/src/tools.ts`；真实项目实测（该包 `docs/REAL-RUN.md`） |
| 导出块为 Simatic ML XML（保留用户组目录） | ✅ | 237 块项目导出 234 个（3 个被 TIA 拒绝并逐块报告）；1152 块正式项目导出 1151 个 / 70.6 MB |
| 导入 Simatic ML 与 SCL/STL 外部源 | ✅ | 导入 override 进原组、写后验证 `passed`、重新导出内容为新值 |
| 编译并返回结构化结果（验证工具） | ✅ | `state=Warning, errorCount=0`；编译报错作为数据返回，不是工具错误 |
| PLC 数据类型（UDT）与标签表 | ✅ | `categories: blocks / types / tag_tables` |
| 工程生命周期与工程数据（创建/保存/归档/取回/属性/语言/文本/TIA 设置） | ⏳ | v0.2：`OperationsProject.cs` + 8 个工具；契约 `docs/EXTENDED-SURFACE.md` |
| PLC 对象增删改（组/表/变量/常量/监视表/软件单元/单实例 DB） | ⏳ | v0.2：`OperationsPlc.cs` + 9 个工具 |
| F 相关（`GlobalSettings` 两个动作、`SafetySettings`、F 签名） | ⏳ | v0.2：`OperationsSafety.cs` + 3 个工具；需装 STEP 7 Safety 与 F-CPU 才能验证 |
| 白名单 + 事务 + 写后读回验证 + dry-run 默认开 | ✅ | 控制器只接受 25 个操作；`ExclusiveAccess` + `Transaction`；`matrix:check` 逐条比对插件侧 `OPERATIONS` |
| 子进程生命周期（`ctx.effect`、超时终止与重启） | ✅ | 71 项测试中 70 通过 / 1 跳过（实测 2026-10-14）；真实宿主加载/退出验证 |
| **给工程上下文插件的服务 `engineeringAccess`**（缝 A / D12） | ✅ | `packages/dsh-tia-openness-v17-min/src/access.ts` + `test/08-access-service.test.mjs`（9 项）；该包 `docs/decisions.md` **D20** |
| 随包出货的 Openness 知识库 skill（文档交付物的雏形） | 🟡 | `skills/`（31 个上游 SKILL.md + 路由 skill）；**尚未逐能力覆盖"何时/怎么/数据怎么用"三问** |

### 缺口

| 缺口 | 影响 | 备注 |
|---|---|---|
| **工具面按控制器操作切分** | 26 个工具一一对应 25 个白名单操作，模型必须自己编排流程；批量数据（指纹、逐文件清单）全进上下文，列表还被渲染层截到 20 行 | 调研与提案见 [`tool-surface.md`](tool-surface.md)；待 A14–A17 拍板 |
| **只有基础能力** | 大量 Openness 能力域没有对应工具 | 能力形态已定（D31）：不拆包、按行由 preset 装配；剩下的是"先做哪些能力" |
| **软件版本只有 V17** | V16/V18+ 用户不可用 | 族内需要新成员，共享内核形态待定 → **A3** |
| **文档未按能力逐条覆盖** | 模型不知道什么时候该用哪个工具、结果怎么读 | 现状是"知识库 + 工具 description"，不是覆盖手册的能力文档 |
| **只有块 / UDT / 标签表** | 硬件组态、在线下载/上传、比较、库、多用户、HMI 均不可用 | v0.2 已补上工程数据、PLC 对象增删改与 F 相关；逐条覆盖见该包 `docs/coverage-matrix.html`（391 条能力条目） |
| **v0.2 的 20 个操作尚未实测** | 真实 TIA 行为（归档取回、工程文本 xlsx 往返、软件单元、F 服务）未知 | 执行该包 `docs/VERIFICATION-PLAN.md` 后回填 `verification.md` 与 README §0 |
| **真实项目里并非所有块都能导出** | ProDiag 语言块、Safety(F-) 块被 TIA 拒绝 | 控制器逐块报告并继续，不中断整批 |
| **导入目标组要显式指定** | 位于用户组的块覆盖失败 | 需传 `target_group`；"导入后重新导出"要放在编译之后 |
| **一次一个宿主进程一个 TIA 会话** | 多会话共享同一控制器并排队 | Openness 本身不允许并发 |
| **超时即丢失会话** | 控制器被终止，TIA 会话丢失（TIA 进程可能仍驻留） | 需 `close_project(close_portal: true)` 正常收尾 |
| **HMR disposer 路径未人工验证** | 运行中禁用/启用插件的行为未证实 | 该包 `docs/verification.md` §B |
| **V18+ 的 Openness 应用白名单未验证** | 受管环境可能需要白名单条目 | 官方解析器的 `WhitelistApp()` 尚未接线 |
| **导出清单没有稳定对象 id** | 对象身份只能靠 `category + group + name` 复合键，**改名即断链**；工程上下文插件与工程知识图谱插件都直接受这条约束 | V17 **没有** `ObjectIdentifierProvider`（V21+ 才有，见 [`decisions.md`](decisions.md) D7 与 [`packages/dsh-engineering-context/docs/ARCHITECTURE.md`](../packages/dsh-engineering-context/docs/ARCHITECTURE.md) §5.2）；清单缺口见该包 [`docs/MANIFEST-GAP-ANALYSIS.md`](../packages/dsh-tia-openness-v17-min/docs/MANIFEST-GAP-ANALYSIS.md) §2/§5。**注意**：那位外部工具的 `id` 算法外部不可复现（同文 §5 第 8 项），所以这条路要的是"从 Openness 现取"，不是"复刻它的 id" |

### 计划做的事

| # | 工作项 | 产出 | 状态 |
|---|---|---|---|
| 1 | 用 Openness manual 做**能力清单**，标出每一条属于哪个能力、是否已适配 | 能力覆盖矩阵（已有 391 条雏形） | 🟡 |
| 2 | **文档补全**：每个能力补齐"何时调用 / 怎么调用 / 结果怎么用"三问 | 能力文档 | ⬜ |
| 3 | 文档与工具的**一致性校验**（改了工具必须改文档，像 `matrix:check` 那样拦下来） | 校验脚本 | ⬜ |
| 4 | 规划能力边界并实现（在线、硬件组态…） | 包内能力行/配置开关 + preset 声明 + 文档 | ⬜ |
| 5 | 加软件版本维度（V18+） | 新成员插件 | ⬜ |
| 6 | **工具面重设计**：从"一个控制器操作一个工具"（26 个）改成**面向用户工作流的少数工具** + 内部合并/分页 + "摘要 + 工件 + 下钻"的返回 | 工作流层工具；调研与提案见 [`tool-surface.md`](tool-surface.md) | 🟡 调研完成，待 A14–A17 拍板 |
| 7 | **稳定对象 id 的可行性核实**（先查证，再决定要不要补字段）：查 Openness V17 有没有可取的逐对象标识；**有** → 补进导出清单/指纹结果并实测其**跨导出稳定性**；**没有** → 明确记为"不可得"，保留复合键降级路径 | 可复核的结论 +（若可行）清单新字段 `tiaObjectId` + 实测记录 | ⬜ |

### 计划中的验收口径

- **覆盖率可度量**：以 Openness manual 的能力清单为分母，逐条标注"已适配 / 计划中 / 不适用"，
  数字可复算（复用现有覆盖矩阵的生成与校验机制）；
- **文档三问无遗漏**：每个能力都必须能回答"何时调用 / 怎么调用 / 数据怎么用"，
  缺一条即视为未交付；
- **文档不过期**：工具签名或行为一变，校验立刻失败。

---

## 3. 工程上下文插件 🟡

**职责**：面对用户的**多个 TIA 项目 × 多个分支 × 多个历史版本**，管理工程上下文，
使得会话中就某个工程问题对话时，工具能暴露出**恰当的工程上下文**。

> **状态：设计 ✅ 已定稿；唯一工具 `create_engineering_project` ✅ 已实现（56 项单测通过，含经缝 B 的图谱建库）；P2（变更检测）/ P3（台账）⬜ 未开始。**
> 落地位置 `packages/dsh-engineering-context`，**已登记进 profile 蓝图**
> （`profile/dsh-automation-suite/package.json` 的 `dependencies` + `dsh.profile.bundles`）。
> 验收：`pwsh -NoProfile -File scripts\start-env.ps1` 之后 `dsh --profile dsh-automation-suite
> --dump-config` 出现本插件行（行数基线见根 `AGENTS.md` §4）；本包自身的
> `check` 可独立跑。
> 设计见该包 [`docs/ARCHITECTURE.md`](../packages/dsh-engineering-context/docs/ARCHITECTURE.md)、
> [`docs/PATH-RULES.md`](../packages/dsh-engineering-context/docs/PATH-RULES.md)、
> [`docs/decisions.md`](../packages/dsh-engineering-context/docs/decisions.md)；
> 发行版级结论见 [`decisions.md`](decisions.md) **D12**。

### 已实现（有单测证据）

| 能力 | 状态 | 证据 |
|---|---|---|
| 把 TIA **当前打开**的工程另存进 workspace（`tia/`），再把源文件树重建到 `source/<device>/`；默认只给计划 | ✅ | `packages/dsh-engineering-context/src/tools/create-project.ts`、`src/access.ts`；`test/02-create-project.test.mjs` |
| 导出完成后经【缝 B】逐设备把块逻辑转译进 `knowledge/<device>/<device>_knowledge.db`（图谱插件的 `knowledgeGraph` 服务，按名取） | ✅ | `src/knowledge-graph.ts`；`test/02-create-project.test.mjs`（工具级）、`test/04-knowledge-graph.test.mjs`（缝级） |
| 图谱这一步是**软的**：服务缺席 / 引擎未构建 / 引擎不可达 → 只报"图谱未建成"，工作流仍成功；引擎拒绝 → 逐设备 code + remediation | ✅ | `src/knowledge-graph.ts`；`test/04-knowledge-graph.test.mjs`（12 项缝级用例，含四种降级与归一化） |
| 目标路径全部由插件推导（工具参数里**没有路径**）+ `realpath` 包含性校验（不串味） | ✅ | `src/config.ts`、`src/paths.ts`、`src/scope.ts`；`test/01-paths.test.mjs`（含兄弟目录同前缀、`..` 逃逸） |
| 目录名安全化：TIA 的项目名 → 单段目录名（非法字符、尾点、Windows 保留设备名、超长） | ✅ | `src/paths.ts`（`folderName`）；`test/01-paths.test.mjs` |
| `.gitignore` 只追加：缺则创建（带注释头）、有则补上缺的那行（`tia/`、`knowledge/**/*.db*`、`.dsh/local/`）、三行都在则不动 | ✅ | `src/tools/create-project.ts`；`test/02-create-project.test.mjs` |
| TIA 侧失败可分辨：`tia_access_unavailable` / `tia_controller_not_running` / `tia_project_not_open` / `save_failed` / `rebuild_failed` / `tia_unreachable`，且说明"哪一半已落盘" | ✅ | `src/errors.ts`、`src/tools/create-project.ts`；`test/02-create-project.test.mjs` |
| 工具面三个，结果有界（列表封顶 20、细节封顶 40 行；被拒对象逐条给） | ✅ | `src/tools/outcome.ts`；`test/03-plugin.test.mjs`（真实运行时的 schema 校验） |
| **版本管理取证（控制器侧，S0/S1）**：`PlcChecksum` 读 `PlcChecksumProvider.Software`；`SyncScan` 自己遍历全部块/类型/标签表，与上一版 evidence 逐对象比对指纹/归一化哈希，只把差异导出到 STAGE 并写下版 `_evidence.json` | ✅ 单测 + 真机通过 | 接口插件 `controller/OperationsSync.cs`、`controller/Evidence.cs`、`src/access.ts`（`readPlcChecksum` / `syncScan`）；控制器自测 17 项（含 3 项 evidence）+ `test/08-access-service.test.mjs` 4 项；`matrix:build` 操作 27 / 工具 26。真机：checksum `C0 01 C3 13 58 AC 0E 50`；全量扫描 1155 块 / 215 类型 / 7 标签表、1376 文件 / 74.8 MB / **121–231 s**（TIA 缓存冷热差异）；**1 块变化的慢路径 48.3 s**（导出 1 块 + 7 标签表 = 8 文件）；同账本 `unchanged` **1.6–3.0 s**；同一 `SyncScan` 调用还增量维护 `_manifest.json`（改名自 `_tia-openness-manifest.json`，无时间戳/绝对路径，标签表只提升真正变化的那张） |
| **版本管理消费侧（S2）**：`project_status` 只读状态（证据账本 / 清单 / git / 锁 / nextAction）；`project_sync` checksum 快路径 → 慢路径 → STAGE → SOURCE，**不提交**；`project_commit` 单独提交 | ✅ 单测；完整真机链路待跑 | 本包 `src/tools/status.ts`、`src/tools/sync.ts`、`src/tools/commit.ts`、`src/commit.ts`、`src/sync.ts`、`src/evidence.ts`、`src/git.ts`、`src/lock.ts`、`src/device.ts`；`test/09-status-sync.test.mjs`（22 项）+ `test/11-project-commit.test.mjs`（6 项）。提交带 `Tia-Op` / `Tia-Checksum` / `Tia-State` trailer；`unchanged` 不产生脏树；失败的扫描也清 STAGE；空信息/无账本/别处脏文件都有守卫（D30） |
| **B1 工具面与 git 底座**：`auditor` preset（create/status/sync/commit/diff/ingest + 只读文件 + `send_message`，无 pwsh/TIA 原子工具/git/图谱下钻）；git 的 12 个模型工具拆到 `dsh-tool-git/tools` 只挂 Leader；`gitContext` 服务按显式根目录解析（无 `repoDir`/`workDir`）；checksum 30s 缓存只服务计划 | ✅ | 蓝图 + `packages/dsh-tool-git`（51 项）+ 上下文（116 项）；`gitContext` 服务 `isRepository` / `repoRoot` / `create` / `init` + bound `run`/`status`/`head`/`commit` |
| **B2 一次性导入**：`create_engineering_project` 在无外仓时初始化 git 并提交 baseline；未编译先拒绝；一次 `SyncScan(adopt_existing:true)` 把已导出的文件采纳为 evidence，不再二次导出；`.gitattributes` 固定 XML 行尾 | ✅ 单测 | 控制器 `adopt_existing`/`data.adopted`（自测 18/18，TIA 102 项）；上下文 116 项；`create` 不再需要模型猜 git 参数 |
| **B3 差异与新鲜度**：`project_diff` 块级结构差异（**Auditor/Expert**，支持 `to:"WORKTREE"`）；图谱 sidecar 以 PLC checksum 报 `fresh/stale/unknown` | ✅ 单测 | 上下文 116 项；图谱 128 项；`project_diff` 13 项 + 新鲜度 5 项；D30 把 diff 从 Leader 移给 Auditor |
| **B4 图谱增量**：引擎 `Update` 替换变更组件 + 一跳依赖闭包、删除被删组件，单事务；`knowledge_update` 工具；`project_sync(refresh_knowledge:true)` 按变更类型/数量选增量或全量，失败只警告 | ✅ 单测 + 引擎自测 | 引擎 128 项（含 Update/删除/拒绝码/回滚）；上下文 116 项；类型/标签表/超 20 文件走全量 |
| **D30 版本管理真的派出去**：`auditor` 成为可派子 preset（`allowedAgentPresets` 含它）；版本工作流三个入口分开挂（`.`→auditor、`/diff`→auditor+expert、`/status`→leader）；sync/commit 两步 + 提交信息由 auditor 生成、经 leader 拿用户确认；XML 编辑纪律进 leader persona | ✅ 单测 + 配置验收；真机链路待跑 | 上下文 116 项（新增 6 项 commit）；`--dump-config` 2003 / 2036 行；`docs/decisions.md` D30 |

### 缺口（P3 起）

| 缺口 | 影响 | 备注 |
|---|---|---|
| ~~**没有版本层**~~ → **已删除**（D22） | 版本化交给用户自己的 git（workspace 就是普通仓库） | 原 `eng_version` + 旧的 `src/git.ts` 一并删除；现在的版本管理是 `project_sync` 的"TIA → SOURCE → 一次提交"（D26），`.ap17` 仍由 `.gitignore` 的 `tia/` 挡在库外，图谱库由 `knowledge/**/*.db*` 挡住，锁/STAGE 由 `.dsh/local/` 挡住 |
| **没有变更检测** | 期望一（识别工程文件是否被更改）与 D6/D9 的工作循环都未落地 | **S2 已接**：checksum 快路径 + 账本慢路径 + `project_sync` 提交；**S3 尚未做**：DRAFT/REMOTE 与逐块指纹锁。指纹可得性由**用户在另一代码库**验证过（**用户侧证据，不是本仓实测**） |
| **S2 的真机链路还没整跑** | 单测里 `SyncScan` 是假服务，真实链路只验过控制器侧与 git 侧两段 | 需要：打开源项目 → `create_engineering_project` → `project_status(verify:true)` → 改一块 → `project_sync(dry_run:false)` → 看 `git log`/`git show`。注意可见窗口打开 68–197 s、慢路径 48.3 s，会话超时要留够 |
| ~~**`PlcChecksum` / `SyncScan` 尚未在真机跑通**~~ → ✅ **2026-10-22 真机验证通过** | `PlcChecksum` 返回 `C0 01 C3 13 58 AC 0E 50`（3.2 s）；`SyncScan` 全量：1155 块 / 215 类型 / 7 标签表，1376 文件 / 74.8 MB / 230.7 s，1 个不可导出（`FOB_SAFETY`）；同账本第二次 `unchanged` 3.0 s；`CloseProject` 7.9 s | **headless 的坑**：2026-10-21 `with_window:false` 在同一工程上 600 s 未返回；可见窗口 68–79 s 成功。S2 的打开路径应沿用可见窗口或复用已开会话，不要默认 headless |
| **没有变更台账** | 期望二（「待办清单」式上下文）未落地 | P3；状态目录随注册表删除后**路径待定**（该包 D22） |
| **没有随包 skill** | D4 三问目前写在工具描述里，没有随包知识库 | P3（与项目级 skill / A12 一起做） |
| ~~**`adopt` 只做字节复制**~~ | ✅ **已解决** | 改为经缝 A 的 `saveProjectAs`（TIA 自己的另存）；旧的字节复制工具已删除（D22） |
| **另存/导出尚未在真机上跑过** | 单测用的是假 `engineeringAccess` 服务 | 真机验收需要 TIA Portal 在线；见接口插件 `docs/VERIFICATION-PLAN.md` |

### 三条期望

| # | 期望 | 具体内容 |
|---|---|---|
| 1 | **对工程对象做优化适配** | 工程项目路径**包括哪些内容**；如何**识别工程文件是否被更改**；这些更改怎样被**区分与跟进** |
| 2 | **用「待办清单」式工具承载工程变更上下文** | 针对用户的工程问题，用类似 Todo 清单的载体承接变更上下文，在**合适的时候**交给 LLM / 用户，**辅助判断用户意图** |
| 3 | **版本间变更明确易读 + 工程对象可交叉关联** | 版本之间的变更人要能读懂、模型也要能读懂；相关联的工程对象要能跨版本关联起来 |

### 计划做的事（顺序即依赖顺序）

| # | 工作项 | 产出 | 状态 |
|---|---|---|---|
| 1 | **workspace 模型**：**认领**宿主已有的 workspace（`ctx.workspaceRegistry`，不自建）→ 其下起 session → 源项目**另存**进 workspace → 导出源文件到项目路径（D5） | workspace 与路径规则 | ✅ **已实现**（`create_engineering_project` 经缝 A 的 `saveProjectAs` / `rebuildSource`、经缝 B 触发图谱建库；56 项单测，真机另存待验） |
| 2 | **路径契约**：workspace 里"放什么、怎么放"的字段级定义 | 路径规范 | ✅ P0（`PATH-RULES.md` 定稿 + 越界校验实现） |
| 3 | **变更识别**：用 TIA 指纹（`FingerprintProvider`）判断块有无变化；分面可区分"改的是哪一部分"（D6） | 变更检测 | ⬜ |
| 4 | **版本模型**：以 git 管理分支与历史版本，定义"当前版本"如何解析 | 版本解析 | ❌ **已删除**（D22）：交给用户自己的 git，插件不再包一层 |
| 5 | **工程作用域**：session ↔ workspace 绑定，显式可查、可切、可追溯（D5） | 作用域标识 | 🟡 **部分**：每次调用从 cwd 重新解析 + 包含性校验（已测）；"显式可切/可追溯"随 `eng_scope` 一并删除（D22） |
| 6 | **变更上下文载体**：Todo 清单式的工具，承接本次会话的工程变更 | 变更清单 | ⬜ |
| 7 | **工作副本物化**：把某个版本变成可解析的导出物，供工程知识图谱插件使用 | 版本 → 导出物 | ⬜ |
| 8 | **工作循环**：改 `.ap17` → 指纹比对 → **只导出变化的块** → 更新图（D9） | 增量刷新 | ⬜ |
| 9 | **版本差异**：从"文件变了"升级为"工程变了"（依赖工程知识图谱插件的图） | 工程级 diff | ⬜ |
| 10 | **对象交叉关联**：以 **TIA 导出物携带的唯一 id** 作身份键，跨版本对应（D7） | 对象身份与关联 | ⬜ |
| 11 | 接入 git 底层能力（复用现有工具族 / git 库 / 命令行 —— 见 **A8**） | 版本操作接口 | ⬜ |

> **设计与 P0 实现带来的口径修正**（详见 `packages/dsh-engineering-context/docs/`）：
> 第 **1** 项**不再是"新建 workspace"** —— 宿主已有 `ctx.workspaceRegistry` 承载 D5 的 workspace 模型，
> 本插件只**认领**它（作用域根 = `session.header.cwd`），产出是"工程注册表 + 路径规则"，已实现；
> 第 **2** 项的字段级定义已定稿并落成越界校验（该包 `PATH-RULES.md` §8 / `src/paths.ts`）；
> 第 **11** 项已按 **A8** 定为"插件内部 `execFile(git)`，不向模型暴露 git 原语"。
> 第 3、6、8 项的实现方式（变更引擎 / 变更台账 / 增量闭环）在该包文档里定死，
> 但仍**依赖真机实测与接口插件族的服务缝**（V17 指纹），所以状态列保持 ⬜。

### 计划中的验收口径

- **可重复**：给定「项目 / 分支 / 版本」能稳定复现同一份导出物（内容可比对）；
- **不串味**：workspace 之间隔离 —— 新会话只能访问自己 workspace 下的项目，同名块、同名类型不得互相污染；
- **作用域显式**：换项目 = 换 workspace，且结论里带得上版本标识；
- **变更不漏报也不误报**：以指纹为硬依据 —— 未改动的项目重复检测应报"无变更"，任一被改动的块应能定位到，
  并能说出**改的是哪一部分**（Code / Interface / Comments / Properties…）；
- **增量可验证**：改动一个块后，工作循环导出的块集合应恰好等于指纹报告变化的集合；
- **变更清单可用**：清单里的每一项都能指回具体的工程对象与版本，且能支撑"用户到底想干什么"的判断；
- **可追溯**：任何分析结论都能回答"基于哪一版"；源文件、图、作用域三者版本不一致时**能检测并报告**；
- **耗时可测**：版本切换与工作副本物化在大项目上（参考：1152 块 / 70.6 MB）的耗时与存储可量化。

---

## 4. 工程知识图谱插件 🟡

**职责**：基于从设备导出的**工程源文件**，解析为 LLM 便于处理的信息：
**解析 XML → 建立图数据库 → 暴露接口**提供所需的工程细节。
**期望**：**准确翻译 XML 中的 PLC 语法，兼容性强。**
**底座已定（D8）**：**SQLite + Graph DB**（已在另一个代码库验证可用），不引入服务型图数据库。

**为什么它可以先动**：这是**纯文本解析** —— 不依赖 TIA Portal、不依赖 Windows，
可以拿真实导出物当 fixture 离线开发与测试。

### 已实现（有实测证据）

| 能力 | 状态 | 证据 |
|---|---|---|
| Simatic ML XML → 图（块 / 网段 / 调用 / 读写 / 类型 / 标签 / IO） | ✅ | `packages/dsh-engineering-graph/engine/`（vendored `Graph` / `Parsing` / `Import`）；7 个真实 V17 fixture crawl 出 **72 节点 / 153 边**，覆盖全部 **15 种节点种类** |
| 图落库到 SQLite（含原生 provider） | ✅ | `--self-test` 的 SQLite 往返（写图 → 读回）；**原生 `e_sqlite3` 运行期加载已验证** —— 这一条编译证明不了 |
| 引擎协议（NDJSON 帧 + 操作白名单） | ✅ | **D19**；`dotnet build` **0 warning / 0 error**；stdio 实测 ready / result / progress 三类帧与四条错误路径 |
| PLC 语法翻译（SCL 与 LAD/FBD 语句级，深度随结果标注） | 🟡 | 来源库的 FlgNet → 类 SCL 翻译器原样移植；**STL / GRAPH 明确不支持**（**D14**） |
| SCL 结构分段（一个 REGION = 一个 network 段） | ✅ | **D27**（2026-10-21）：纯 SCL 块按 `REGION` 全深度分段，region 外正文成 `module` 段，仍 >6,000 字符的段按语句边界切 `part`；读写与正文按段归属，`segmentKind`/`regionPath`/`enclosingControl`/`tiaNetworkIndex` 落在节点属性上（旧库缺属性时退化，不加列）。真实工程：`LAxisCtrl_Axis` 1 → 103 段、83,742 → 4,683 字符；SCL 段最大 5,809；4550 → 4899 网络；逐块读写并集与旧库相等。顺带修掉 `Constant`/`PredefinedVariable` 丢名字与 `/* */` 未剥离两个渲染漏洞 |
| 查询接口 | ✅ | 只读 SQL（`knowledge_query`，渲染预算化：逐字段截断可用 `max_field_chars` 放宽 + 超限给翻页指引）+ schema + 发现（`knowledge_workspace`）+ **四个下钻工具**（`knowledge_search` / `knowledge_block` / `knowledge_network` / `knowledge_variable_usage`，2026-10-19 **D24** 阶段 3；TS 侧固定 SQL，零 C# 改动） |
| 测试与 CI 覆盖 | ✅ | 该包 **111 项** `node:test`，含**经真实引擎**的端到端（ingest → query → 计数、只读闸门拒绝 `DROP`）与传输层故障注入；引擎自检也被 `pnpm test` 覆盖 |
| 新鲜度 / 增量更新 | ⬜ | 属 **D13** 第 4 步。来源库**没有** `status` 操作（新鲜度住在消费端），需新写；contentHash 兜底还须先归一化 |
| 兼容层（跨版本 / 跨来源降级） | ⬜ | 目前只有 manifest 与 crawl 两条入口，没有按版本降级 |
| LLM 友好的分级表示（项目摘要 + 分页） | 🟡 | 第 8 项。`knowledge_networks` / `knowledge_network_accesses` / `knowledge_search` 三张投影表已由四个下钻工具暴露，逻辑按 `offset`/`max_chars` 分块（默认 3000、硬顶 6000）；**SCL 侧已按 REGION 分段**（**D27**，95% 以上的段一次读完），**项目级摘要**还没有 |

> **已登记进蓝图（2026-10-15）**：`profile/dsh-automation-suite/package.json` 的 `dsh.profile.bundles` 已含它。
> 注意 D23 之后工具面**按 preset 分发**：`leader` 是 4 个、`expert` 是 3 个（不含 `knowledge_ingest`），
> 不再是"每个会话都有"。
>
> **数据库位置（D20）**：`<项目根>/knowledge/<device>/<device>_knowledge.db` —— `knowledge/` 与 `source/` 同级，
> 一台设备一个文件夹放它自己的全部生成物，`*.db` 不进 git。`knowledge_ingest` 的 `device_dir` 指向
> `<项目根>/source/<device>`，省略 `db_path` 时就用这个约定。
>
> **已接进族 2 的工作流（2026-10-17，族 2 D25）**：除工具外，本包还注册 cordis 服务
> **`knowledgeGraph`**（`src/service.ts`；按名取、不 import）。工程上下文插件的
> `create_engineering_project` 在导出完成后逐设备调用它的 `ingestDevice`，把块逻辑转译进
> `knowledge/<device>/`。这一步是**软的**：服务缺席 / 引擎没构建 / 引擎不可达时只报"图谱未建成"，
> 工作流照常成功（工程与源文件树仍是它的交付物），工具级与缝级的 19 项新测试覆盖这些降级路径。
>
> **两个 Loader 行（2026-10-19，发行版 D23）**：宿主行 = C# 引擎子进程 + `knowledgeGraph` 服务；
> `/tools` 行 = 模型面工具，带 `includeIngest` 开关。子 agent preset `expert` 用
> `includeIngest: false` 只拿到 `knowledge_workspace` / `knowledge_schema` / `knowledge_query`。
>
> **发现与查询可用性（2026-10-19，发行版 D24）**：`knowledge_workspace` 让模型自己读到工程身份、
> 每台设备的库路径/大小/mtime 与 `device_dir`；`knowledge_query` 的 `db_path` 可省略
> （单库自动、零库/多库拒绝并列出候选）。新鲜度仍 ⬜ —— 库是派生快照，persona 明确禁止只凭库断言
> 代码"改了/没改"。
>
> 仍待做：**新鲜度/增量**（没有它，唯一刷新方式就是"每次导出后整库重建"；
> 实测 1376 个源文件约 30 s、库约 450 MB，图谱插件的 `requestTimeoutMs` 默认 300 s 要留够）。

### 计划做的事（顺序即依赖顺序）

| # | 工作项 | 产出 | 状态 |
|---|---|---|---|
| 1 | Simatic ML XML 解析：块清单、块属性（编号/语言/时间戳）、所属组 | 工程块索引 | 🟡 |
| 2 | **PLC 语法翻译**：**SCL 与 LAD/FBD（含 Safety 的 `F_LAD` / `F_FBD`）做到语句级，其他块语言暂不支持**（**D14**；深度随结果标注 `confidence`） | 语法模型 | 🟡 |
| 3 | 调用关系抽取（块 → 被调用块）；**边只来自 XML 解析**（**D15**），不取 TIA 交叉引用 | 块级调用图 | ✅ |
| 4 | 数据类型与实例关系（UDT、DB 结构、标签表、I/O 映射） | 类型与变量索引 | 🟡 |
| 5 | **兼容性**：识别不同版本 / 不同来源导出物的差异，按能力降级而非直接失败 | 兼容层 | ⬜ |
| 6 | **图模型落库**到 SQLite + Graph DB（节点/边候选见 [architecture.md](architecture.md) §4.3） | 图数据库 | ✅ |
| 7 | **查询接口**：按需下钻（某个块、某条调用链、某张表） | 工程细节查询 | 🟡 |
| 8 | **LLM 友好的表示**：项目级摘要 + 分页/索引/引用，而不是全文灌入 | 工程上下文接口 | ⬜ |

> **口径已定（2026-10-14）**：**A10 / A11 / A13 / B16** 已答，结论落在 [`decisions.md`](decisions.md) **D13–D16** ——
> 分区与更新见 **D13**、翻译深度见 **D14**、边的来源见 **D15**、能力暴露形态见 **D16**。
> 上表第 2、3 项的"待定"标记因此去掉。
>
> **实现进度（2026-10-15）**：第 3、6 项已实现，第 1、2、4、7 项部分实现 ——
> 逐项证据见上面的「已实现」表；协议与工具命名见 **D19**，包与 C# 命名见 **D17**。

> 第 8 项是这一层的**成败关键**：一个真实项目导出后是上千文件 / 几十 MB，
> "把 XML 交给模型"与"让模型按需查看工程结构"是两种完全不同的可用性。

### 计划中的验收口径

- **准确**：以真实导出物为 fixture，断言还原出的块集合、组层级、调用关系与 TIA 侧一致；
  语法翻译的正确性优先于覆盖面 —— **宁可明确报"不支持这种写法"，不要猜**；
- **兼容**：同一份测试集覆盖多个 TIA 版本的导出物与多种块语言，逐项记录支持状态；
- **上下文预算**：项目级摘要必须在**固定上限**内（不随项目规模线性增长），细节按需展开；
- **降级不崩**：单个文件解析失败只影响该文件的结论，并在结果里显式报告；
- **离线可 CI**：不依赖 TIA 即可跑通全部测试；
- **规模可测**：以 1152 块 / 70.6 MB 的真实导出物为基准，记录解析与建图耗时、图的存储占用。

---

## 5. 依赖与建议推进顺序

- **接口插件族 → 工程知识图谱插件是硬依赖**：图谱的输入就是接口插件族的导出物。
- **工程上下文插件已确认可以独立起步**：workspace 建立 + 指纹变更检测 + 版本管理都不依赖图谱
  （"告诉我这个项目自上次以来哪些块变了"本身就有用）。
- **建议顺序**：接口插件族（补完）→ 工程知识图谱插件（拿到语义）→ 工程上下文插件（把语义限定到正确的范围）。

> 顺序**不再是阻塞问题**：A5（作用域绑定）已按 **workspace 模型**定下来（[`decisions.md`](decisions.md) D5），
> 所以先做工程上下文插件同样成立 —— 两种排法只差优先级。

---

## 6. 开放问题

开放问题已独立成一份**可直接编辑**的文件：[`open-questions.md`](open-questions.md)。

- 共 **34 条**，分两部分：**A · 必须先定**（17 条，会阻塞动手，含 A14–A17 工具面问题）
  与 **B · 可以后定**（17 条）；
- **已答 16 条**（A1–A9、B1–B4、B7–B9），结论已落进 [`decisions.md`](decisions.md)；
- 答复写在那个文件里（每条下面留了 `**答复**：`），本文档**不重复列表**，避免两处不一致；
- 答完后把结论落进 [`decisions.md`](decisions.md)、[`architecture.md`](architecture.md)
  与本文件的对应章节，并去掉"待定"标记。

---

## 7. 范围扩展（未排期）

以下都是**方向**，没有排期，也没有设计：

- **更多 TIA 版本**：V18+（受管环境还有应用白名单问题）、V16（D3：第二个版本到来时抽 core 包）；
- **更多工程对象**：硬件组态、HMI、库、多用户、在线下载/上传与比较（按 D1 的维度分组，由 D31 决定装配）；
- **其它厂商的工程软件**：**当前只规划 Rockwell，其他厂商暂无计划**（D11）；
- **仿真 / 运行态**：S7-PLCSIM Advanced 的接入评估与方案见 [`simulation-plcsim-advanced.md`](simulation-plcsim-advanced.md)（提案：独立插件 `dsh-plcsim-advanced`；**全链路已跑通**：TIA V17 + PLCSIM V7 TCP/IP，`adopt_open_project` → `download` → RUN → 51 标签 → Bool 读写；**两次一次性人工前置**：工程 PLC 配子网/IP、TIA UI 接受首次证书；**后续快速复用**：首次成功后 `snapshot`，下次 `resume` 直接启动（无需 TIA/重下）；Softbus 仅 V20 可用（V17 Openness 只枚举 TCP/IP）；**未排期、未改状态**）；
- **跨项目视角**：把多个项目的工程上下文放在一起比较与复用。

---

## 8. 维护约定

- **状态只在两处维护**：本文件与根 [`README.md`](../README.md) §2 的进度表；
  任一能力落地或口径变化时**同时更新**，不要让两处互相矛盾。
- **"已实现"必须有证据**：代码 + 测试，或可复现的实测记录；写不出证据的一律标 ⬜/🟡。
- **技术取舍写进各包的 `docs/decisions.md`**；本文件只回答"做到哪了、还差什么"。
- 覆盖矩阵类生成物（如 TIA 包的 `docs/coverage-matrix.html`）不在这里重复，工具层能力以它为准。
