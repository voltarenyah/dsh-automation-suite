[English](README.en.md) | **简体中文**

# dsh-automation-suite

> **DeepSeek Harness 的自动化发行版**：一份 profile 蓝图 + 两个插件，让 `dsh` 里的模型
> 能直接读写 **TIA Portal V17** 的 PLC 程序块，并以结构化、默认安全的方式操作 **Git**。
>
> An unofficial DeepSeek Harness distribution: a profile blueprint plus two plugins that
> give the model verified TIA Portal V17 Openness block access and a structured,
> guard-railed Git tool family.

![license](https://img.shields.io/badge/license-MIT-blue)
![plugins](https://img.shields.io/badge/plugins-2-4D6BFE)
![tools](https://img.shields.io/badge/tools-18-4D6BFE)
![node](https://img.shields.io/badge/node-%E2%89%A522.19-339933?logo=node.js&logoColor=white)
![platform](https://img.shields.io/badge/TIA%20plugin-Windows%20only-0078D4?logo=windows&logoColor=white)

> ⚠️ **非官方项目**：与 DeepSeek（DeepSeek Harness 的发行方）无关，与 Siemens 也无隶属关系。
> `dsh-tool-git` 是上游 [`lxj808624/dsh-tool-git`](https://github.com/lxj808624/dsh-tool-git)
> 的 vendor 副本（MIT），出处与差异见 [§15](#15-许可证与第三方)。

---

## 目录

1. [这是什么](#1-这是什么)
2. [它要解决的问题](#2-它要解决的问题)
3. [交付内容一览](#3-交付内容一览)
4. [功能是怎么实现的](#4-功能是怎么实现的)
5. [环境要求](#5-环境要求)
6. [快速开始](#6-快速开始)
7. [交互使用](#7-交互使用)
8. [配置](#8-配置)
9. [仓库结构](#9-仓库结构)
10. [开发](#10-开发)
11. [验收](#11-验收)
12. [故障排查](#12-故障排查)
13. [已知边界](#13-已知边界)
14. [安全红线](#14-安全红线)
15. [许可证与第三方](#15-许可证与第三方)
16. [文档索引](#16-文档索引)

---

## 1. 这是什么

在 DSH 里，一个"发行版"不是单个包，而是两样东西的组合：

| 组成 | 在本仓里的位置 | 作用 |
|---|---|---|
| **profile 蓝图** | `profile/dsh-automation-suite/` | 声明"一个 profile 目录应该长什么样"：装哪些 bundle、按什么顺序叠加 |
| **插件（bundle）** | `packages/*` | 真正提供能力的模块，运行在 DSH 宿主进程里 |

蓝图**不是** bundle，它要物化成 `~/.dsh/profiles/<name>/` 之后才被 `dsh` 当作 profile 使用。
本仓没有把发行版做成"一个巨型插件"，而是做成**可拆的组合**：

- 想要整套 → 按蓝图物化 profile，一次拿到全部能力（[§6](#6-快速开始)）；
- 只想要其中一个 → `packages/` 下的每个包都是**可独立安装的 bundle**，
  `dsh plugin --profile <p> add <包名或 tarball>` 即可。

本仓是 **Monorepo**：`packages/*` 放插件，`profile/*` 放蓝图，`scripts/` 放 Monorepo 级工具，
`docs/*` 放发行版层面的文档。

> **当前状态：这套方案的雏形。** 仓库今天跑得通的是价值链条的**第一层**（把内容从工程软件里
> 取出来、写回去）以及管理层的一件通用工具（git）；**语义层尚未开始**。分层方案、
> 每层的职责与已实现/规划中的边界，见 [§2](#2-它要解决的问题)、
> [`docs/vision.md`](docs/vision.md) 与 [`docs/roadmap.md`](docs/roadmap.md)。

---

## 2. 它要解决的问题

工业控制领域的 **PLC 项目文件无法被 LLM 很好地访问、理解与操作**：TIA Portal 的 `.ap17`、
以及各家的专有工程格式，把程序结构、调用关系与工程要素锁在专用工程软件里。文本模型
既**读不到**、也**读不懂**（没有结构化语义），更**不敢改**（改完无法验证是否成立）。
于是它在工控领域能提供的帮助极其有限。

打通这条链路要**分层**做，每一层解锁下一层：

| 层 | 要做什么 | 交给下一层什么 | 现状 |
|---|---|---|---|
| **① 接入层**<br>打通工具障碍 | 通过工控软件预留的接口（TIA Openness 等）把程序源文件**取出来**、改完**写回去** | 程序源文件（Simatic ML / SCL / STL） | 🟡 部分实现：TIA V17 的块读写、工程数据、PLC 对象增删改、F 相关与在线会话、下载与 UI 会话接管接口已接通（32 个工具）；其中 v0.2 新增的 20 个操作待真机验证 |
| **② 语义层**<br>让模型读懂 | 解析源文件、**还原工程信息与要素**，转换成 LLM 擅长处理的格式 | 可推理的工程上下文 | ⬜ 未实现：目前把 XML 原样交给模型 |
| **③ 管理与协作层**<br>补齐软件短板 | 在工程软件预留的**项目级**接口之上，做它本身没有的能力 | 项目级工作流与建议 | 🟡 只有通用 git 工具，尚未与 PLC 项目打通 |

**本发行版就是这条链路的载体**：它由**多个插件**组成，每个插件负责其中一个方面。
层的划分与设计原则见 [`docs/vision.md`](docs/vision.md)，插件的职责边界与契约见
[`docs/architecture.md`](docs/architecture.md)，逐项进度见 [`docs/roadmap.md`](docs/roadmap.md)。

### 目标插件构成

| 名称 | 对应层 | 负责什么 | 现状 |
|---|---|---|---|
| **工控软件接口插件族**<br>（以 TIA 为例即 `tia-openness`；按**软件版本**分成员：V17/V18…；能力不拆包、由 preset 装配，见 D31） | ① 接入层 | 与工控软件对接、**读写工程对象**；为后续分析提供**素材**与**验证工具**；并**附带文档**说清每个能力"何时调用 / 怎么调用 / 调用后的数据怎么用" | 🟡 已有 **V17**（定位是验证基础功能） |
| **工程上下文插件** | 作用域（横向） | 管住用户的**多个 TIA 项目 × 多个分支 × 多个历史版本**；对工程对象做优化适配（路径内容、变更识别与跟进）；用**「待办清单」式工具承载工程变更上下文**，在合适的时候交给 LLM 辅助判断用户意图；版本间变更明确易读、工程对象可交叉关联 | 🟡 部分实现（4 个工具：`create_engineering_project` / `project_status` / `project_sync` / `project_commit`；TIA → SOURCE 的 checksum+指纹同步已通，**同步与提交分两步**，116 项单测；DRAFT/REMOTE 与变更台账未做；**已登记进蓝图**，见 [`packages/dsh-engineering-context/docs/`](packages/dsh-engineering-context/docs/)） |
| **工程知识图谱插件** | ② 语义层 | **准确翻译 XML 中的 PLC 语法**（兼容性强）：解析工程源文件 → **建立图数据库** → 暴露接口给出工程细节 | 🟡 部分实现（引擎 + 协议 + 8 个工具 + `knowledgeGraph` 服务，104 项单测；**已登记进蓝图**，并被族 2 的工作流调用） |

插件不再编号：**只有接口插件族是"一族多成员"**（成员 = 软件版本；能力不拆包，见 D31），工程上下文插件与
工程知识图谱插件都是**单一插件**。编号只保留给 [`docs/vision.md`](docs/vision.md) §3 的**层**
（① 接入层 / ② 语义层 / ③ 管理与协作层）。依赖关系与建议顺序见 [`docs/roadmap.md`](docs/roadmap.md) §5。
各插件的定位、期望与边界见 [`docs/architecture.md`](docs/architecture.md) §4。

### ① 接入层：先打通工具层面的障碍

工控程序的一切都在专用软件里，所以第一步只能是**用它自己预留的接口**把内容取出来。
本仓已实现的一段是 TIA Portal V17 Openness：工程生命周期与工程数据、PLC 块/类型/标签表读写、
PLC 对象增删改、监视表与软件单元、F 相关服务、编译与关闭项目，且写入走白名单 + 事务 + 写后读回验证（细节见 [§4.2](#42-tia-插件两层架构--白名单控制器)）。
这一层的关键不是"能调通 API"，而是**把不可能暴露给模型的任意代码执行，压缩成一组数据化操作**。

### ② 语义层：把工程信息还给它

导出物只是**文件**（XML、SCL、STL），不是**工程语义**。要让它对模型有用，还需要解析这些源文件、
还原出工程信息与要素 —— 块、块的调用关系、数据类型（UDT）、标签表、I/O、组层级 ——
再把它们转换成 LLM 擅长处理的格式（结构化、可导航、按需展开），而不是把几十 MB 的 XML
整个塞进上下文。**这一层做完，模型才谈得上给出程序诊断、分析与编写方面的建议。**

### ③ 管理与协作层：补齐软件短板，管好"在谈哪一版"

工程软件本身往往缺项目级能力，最典型的就是**版本管理**：TIA Portal 没有项目级 VCS，
而 `.ap17` 是二进制工程文件，直接丢进 git 只能得到"变了 / 没变"。可行的路子是
"**导出为文本源 → 交给外部工具（git）做版本管理 → 需要时再导回**"，并让模型帮忙生成
有意义的差异说明与提交。

这一层还要回答一个更容易被忽略的问题：**现在谈的是哪个项目的哪个分支的哪个版本**。
一个用户的资产通常是"多项目 × 多分支 × 多版本"，没有作用域，答案可能对、却对不上版本。
这条链路每一环都依赖前两层：没有①取不出文本、也写不回去；没有②得到的只是文本 diff
而不是**工程变更**（改了哪个块、影响了谁）。

### 今天已经能做什么

上面两层还在路上，但**接入层这一段已经可用**，配合管理层里的通用 git 工具，
今天就能完成下面两件事。

#### 场景 A —— 用自然语言改 PLC 程序（TIA Portal V17）

工程师的日常是"打开项目 → 找到某个块 → 改一行 → 编译验证"，这些动作要么在 TIA 界面里点，
要么写 Openness 脚本。本发行版把这条链路交给模型：

- 模型**读**：导出项目里的 PLC 块（Simatic ML XML，保留用户组目录层级），或只看块清单与元数据；
- 模型**写**：改 XML / 写 SCL 外部源，再导入回去，**覆盖前先预演**；
- 模型**验**：写后读回项目块集合逐个确认，再编译并读编译结果。

**核心约束**：不给模型"任意代码执行"。模型能表达的只有路径、块名、枚举这些**数据**，
真正执行的是固定白名单里的 5 个操作。

> 注意这一段的边界：模型今天拿到的是**导出的文件本身**，工程语义（调用关系、影响面、
> 标签与 I/O 的对应）还没有被还原出来 —— 那正是②语义层要补的。

#### 场景 B —— 让模型安全地用 Git

模型写代码时高频要用 git，而原版运行时只有裸 `bash`：命令靠字符串拼、输出是给人看的散文、
`push --force` 和 `reset --hard` 没有任何闸门。本发行版补上 12 个结构化 git 工具
（shell-free、返回 JSON），并加一道 `tools/pre-execute` 闸门 —— 破坏性 git 操作
**无论经插件工具还是经 shell 工具**发起，默认都被拒绝并给出解释。

这是③管理层要用的**通用底座**：它现在与 PLC 项目还没有任何耦合，把它接上去需要先完成②。

### 已经解决的技术难题

| 难题 | 本发行版的解法 |
|---|---|
| Openness 只能被 **.NET Framework x64** 进程调用，Node 进程调不了 | 插件持有 C# 控制器子进程，用 NDJSON over stdio 通信 |
| Openness 对象**非线程安全**，一次只能有一个客户端 | 一个宿主进程只有一个控制器；跨会话请求在控制器内排队串行 |
| 写入失败必须保证项目不被写坏 | `ExclusiveAccess` + `Transaction`，全部成功才 `CommitOnDispose()`，否则 dispose 即回滚 |
| 模型可能调用破坏性 git 命令 | `tools/pre-execute` 策略闸门：`deny`（默认）/ `ask` / `allow` |
| 长操作可能卡死 | 每请求硬超时；超时**终止**控制器（Openness 不可取消），下次调用自动重启 |

### 当前进度与路线图

| 插件 | 目标 | 状态 |
|---|---|---|
| **工控软件接口插件族** | 把工控软件暴露的能力整体变成 LLM 的能力范围（含配套文档） | 🟡 **V17**（块·UDT·标签表）；在线/硬件组态等更多能力与 V18+ 待补（不拆包，由 preset 装配，D31） |
| **工程上下文插件** | 管住"现在谈的是哪个工程、它在 workspace 的哪里、它和 TIA 是否一致" | 🟡 **部分实现**：4 个工具（116 项单测）—— `create_engineering_project` 把 TIA 打开的工程另存进 workspace、读源文件树、经【缝 B】逐设备触发知识图谱建库；`project_status` 只读账本/清单/git/锁并给出下一步；`project_sync` 用 PLC checksum 快路径 + 逐对象指纹/归一化哈希慢路径，只把差异提升进 SOURCE，**不再提交**；`project_commit` 用调用方给的信息把这次同步提交成历史（`message` 必填、默认只给计划、插件补 trailer）。**同步与提交分两步**是为了让"变了什么"先被读到、提交信息由人确认（D30）；`project_diff` 走独立入口。图谱缺席/引擎未构建只报"图谱未建成"，不让流程失败。DRAFT/REMOTE 与变更台账未做。P0 的工程注册表与 P1 的内部 git 版本层**已删除**（该包 D22；现行版本管理见 D26）。**已登记进蓝图**（`--dump-config` 行数见根 `AGENTS.md` §4，DSH 0.2.1-rc.2） |
| **工程知识图谱插件** | 准确翻译 XML 中的 PLC 语法，XML → 图数据库 → 按需给出工程细节 | 🟡 **部分实现**：Simatic ML → 图 → SQLite 已通（7 个真实 fixture 出 72 节点 / 153 边，覆盖 15 种节点种类），引擎协议 + 8 个工具 + `knowledgeGraph` 服务（111 项单测，含经真实引擎的端到端）；**被族 2 的 `create_engineering_project` 调用**（该包 D25）。`knowledge_workspace` 让模型自己读到库路径、`knowledge_query` 的 `db_path` 因此可省略，四个下钻工具（search / block / network / variable usage，TS 侧固定 SQL，零 C# 改动）把程序逻辑读成有界答复（**D24** 两阶段）。**新鲜度/增量、兼容层未做**。**已登记进蓝图** |

逐项进度、缺口与验收口径见 [`docs/roadmap.md`](docs/roadmap.md)；
已定的取舍见 [`docs/decisions.md`](docs/decisions.md)，**34 条待决策问题在
[`docs/open-questions.md`](docs/open-questions.md)**（已答 16 条，可直接编辑填写答复）。
**路线图是方向性说明，不是承诺**；已实现与规划中的能力在本文档里始终分开陈述。

---

## 3. 交付内容一览

| 交付物 | 类型 | 版本 | 提供什么 |
|---|---|---|---|
| `@voltarenyah/dsh-tia-openness-v17-min` | 插件 bundle | 0.1.0 | **三个 Loader 行**：宿主行 = TIA 控制器子进程 + `engineeringAccess` 服务 + 随包 skill；`/tools` 行 = **32 个工具**：工程生命周期与工程数据 8（`create_project` / `save_project` / `archive_project` / `project_info` / `project_languages` / `project_texts` / `update_project` / `portal_settings`）、PLC 设备数据 9（`list_plc_objects` / `create_plc_objects` / `delete_plc_objects` / `write_tags` / `set_block_attributes` / `protect_blocks` / `generate_source` / `watch_and_force_tables` / `software_units`）、F 相关 3（`safety_status` / `set_safety_settings` / `safety_signatures`）、在线会话 4（`online_targets` / `online_connect` / `online_status` / `online_disconnect`）、下载 1（`download`）、接管 UI 工程 1（`adopt_open_project`）、块读写主线 5 + `controller_status`；`/commands` 行 = **7 个 `/tia-…` 斜线指令**（`open` / `save` / `compile` / `close` / `info` / `find` / `status`，绕过模型直接在对话框执行）。工具行由 preset 声明（`leader` 有、`expert` 没有）；命令行独立于工具行，只 inject `commands` + `tiaOpennessRuntime`。v0.2 的 20 个新操作**尚未在真实项目上验证**（见该包 `docs/VERIFICATION-PLAN.md`）；控制器白名单另有 2 个**服务专用**操作（`PlcChecksum` / `SyncScan`，供工程上下文插件做版本取证，不注册模型工具），操作总数 33。2026-10-22 真机验证：`PlcChecksum` 3.2 s；`SyncScan` 全量 1376 文件 / 121–231 s，同账本第二次 `unchanged` 1.6–3.0 s，1 块变化的慢路径 48.3 s（导出 1 块 + 7 标签表）；可见窗口打开工程 68–197 s（headless 会挂） |
| `dsh-tool-git` | 插件 bundle（vendor） | 0.1.3 | **12 个工具**：`git_status` / `git_diff` / `git_log` / `git_branch` / `git_stage` / `git_commit` / `git_stash` / `git_show` / `git_fetch` / `git_pull` / `git_remote` / `git_checkout`；外加破坏性命令闸门与 **`gitContext` 服务**。模型面工具已拆到 `dsh-tool-git/tools`，**只挂 `leader`**；`auditor` / `expert` 看不到。服务按显式根目录解析，模型不再传 `repoDir` |
| `@voltarenyah/dsh-engineering-context` | 插件 bundle | 0.1.0 | **4 个工具、三个 Loader 入口**：`.`（`create_engineering_project` 把 TIA 当前打开的工程另存进 `<workspace>/tia/<workspace 名>/`、把源文件树重建到 `<workspace>/source/<device>/`、再经【缝 B】逐设备调用图谱插件的 `knowledgeGraph.ingestDevice`；`project_status` 只读：哪个 PLC、账本/清单在不在、git 状态、锁、下一步动作；`project_sync` TIA → STAGE → SOURCE，**不提交**；`project_commit` 用调用方给的信息提交设备目录，`message` 必填、默认只给计划）、`/diff`（`project_diff`：块级结构差异，支持 `to: "WORKTREE"`）、`/status`（只有 `project_status`）。同步的相等性来自 **PLC 级 checksum**（快路径）+ **逐对象指纹/归一化哈希**（慢路径）：账本 `source/<device>/_evidence.json` 是权威、`_manifest.json` 是派生清单，两份文档由**同一次 `SyncScan` 调用**写出；STAGE 与锁落在 `<workspace>/.dsh/local/`（不进 git），`.gitignore` 只追加 `tia/`、`knowledge/**/*.db*`、`.dsh/local/` 三行。提交信息尾部由插件追加 `Tia-Op` / `Tia-Checksum` / `Tia-State` trailer。**同步与提交分成两步**（D30）：`project_sync` 只写树并返回 `pending.paths` + `pending.suggestedMessage`，`project_commit` 才写历史。**未实现**：DRAFT/REMOTE 与逐块指纹锁（S3）、变更台账。**已删除**：P0 的工程注册表与 P1 的内部 git 版本层，以及 `eng_status` / `eng_project` / `eng_scope` / `eng_version` 四个工具（该包 D22）。**没有宿主面资源**：`.` 只挂 `auditor`，`/diff` 挂 `auditor` + `expert`，`/status` 只挂 `leader` |
| `@voltarenyah/dsh-engineering-graph` | 插件 bundle | 0.1.0 | **两个 Loader 行**：宿主行 = C# 引擎子进程 + `knowledgeGraph` 服务（供族 2 的 `create_engineering_project` 逐设备调用）；`/tools` 行 = **9 个工具**：5 个共享工具（`knowledge_workspace` / `knowledge_schema` / `knowledge_ingest` / `knowledge_update` / `knowledge_query`）+ 4 个下钻工具（`knowledge_search` / `knowledge_block` / `knowledge_network` / `knowledge_variable_usage`，TS 侧固定 SQL，零 C# 改动）。`knowledge_update` 是增量入口：按 `source_components` 替换变更组件并重扫一跳依赖闭包，整批一个事务；没有 provenance / 超上限 / 类型或标签表变化时由调用方回退全量。`includeIngest: false` 去掉两个写工具，`includeDrilldown` 三档（`none` / `inspect` / `all`）：`leader` 用 `inspect`、`expert` 用 `all`—— Simatic ML XML → 属性图 → SQLite，引擎以 net8 子进程运行（`engine/`）。**纯 SCL 块按 `REGION` 分段**（**D27**）。`knowledge_workspace` 不碰引擎：它读会话工作目录，报出工程身份、每台设备的库路径/大小/mtime、`device_dir` 与 **graphFreshness**（sidecar checksum vs `_evidence.json`），所以 `knowledge_query` 的 `db_path` 可以省略（单库自动解析，零库/多库拒绝并给候选，**D24**）。**未实现**：按需下钻工具（某个变量用法）、兼容层。数据库位置与目录约定见 [`docs/roadmap.md`](docs/roadmap.md) §4 |
| `dsh-ui-plc-source` | 插件 bundle（**浏览器半侧 + 一个宿主 pre-step 监听**） | 0.1.0 | **一个 Loader 行 + 一个右侧栏 tab 类型**：在 dsh-web 右侧栏（Files / Terminal / Browser 之后）增加 **PLC Blocks**。读 `<workspace>/source/<device>/_manifest.json`，把每个对象**平铺**成一行（类型徽章 / 名称 / 编号 / 语言 / 大小 / 写后校验标记），可按 **device** 与 **simaticType** 筛选、按名称或编号搜索；TIA 拒绝导出的对象（`failures[]`）同样列成一行（标「拒绝」、可悬停看原因）。**单击是选中**（选中态暂不触发动作），**右键菜单**里才打开源文件（走既有文档预览）或「在对话里提及」（把 `@'块名'` 插进输入框；宿主半侧在 `agent/pre-step` 把该块的 device/类型/编号/语言/文件路径补进 prompt）。筛选/搜索/选中/滚动位置与已读数据放在 slot store 里，切走再切回不丢、也不重读清单。**界面文字跟随 DSH 的语言设置**（设置 → 通用 → 语言，中/英），切换时不用刷新，已打开的 tab chip 也会变。宿主半侧只做这件事（`agent/pre-step` 监听，无工具、无子进程）；清单不可读时该 device 退回目录列举。可行性与机制见 [`docs/ui-plugins.md`](docs/ui-plugins.md)，本插件的计划与验收见 [`docs/ui-plugins-plc-blocks-plan.md`](docs/ui-plugins-plc-blocks-plan.md) |
| `dsh-ui-tia-console` | 插件 bundle（**仅浏览器半侧**） | 0.1.0 | **一个 Loader 行 + 输入框上方的 TIA 控制台**：显示「无项目 / 正在打开 / 已打开 · 项目名 / 正在保存 / 正在编译（已用时长）/ 正在关闭 / 不可用」，并直接提供 **打开 / 保存 / 编译 / 关闭 / 刷新** 五个按钮。按钮 dispatch 现有 `/tia-*` 指令，状态从会话的 `command/*`、`tool/*` 事件折叠而来 —— 模型调用、斜线指令、按钮三种触发都实时反映；空会话也可见（它挂在 `conversation.input.dock`，不依赖时间线）。刷新用 `/tia-info` 与控制器对齐。带展开面板（项目路径、最近编译、最近错误、最近结果）。**Step 1 边界**：状态按会话折叠，其他会话或外部关闭 TIA 后需点刷新校准；全局状态服务是下一步。 |
| `profile/dsh-automation-suite` | profile 蓝图 | 0.1.0 | 把官方 Web 组合（`dsh-base` + `dsh-web-app`）与上面的本地插件叠成一个可直接启动的 profile；并声明三个 preset：`leader`（主 agent）、`auditor`（版本管理）与 `expert`（子 agent）。另外挂一行**公共插件** `dsh-opencode-go@0.1.15`（npm 上的 OpenCode Go 提供方 + 设置页，与桌面 profile 同版本；钉死版本、`pnpm-workspace.yaml` 里为它写了 `allowBuilds`，理由见该目录 README） |
| `scripts/start-env.ps1` | 启动器 | — | 一条命令完成"物化 profile + 装插件 + 起服务 + 带 token 开浏览器" |
| `scripts/clean-build.mjs` | 工具 | — | 只清理 `lib/`、`dist/`，遇链接只 unlink、不递归下降 |

主 agent（`leader`）名下有本发行版自己的 **44 个工具**（TIA 26 + git 12 + 工程上下文 `project_status` 1
+ 图谱 5，`includeDrilldown: inspect` 且 `includeIngest: false`），全部在同一个会话里可用 ——
例如"改完这个块，编译一下"；另有内置 `standard` 自带的那批（fs / 检索 / skills / todo / web / present / subagent …）。
它**不再持有** `create_engineering_project` / `project_sync` / `project_commit` / `project_diff` /
`knowledge_ingest`：这五个是分钟级的版本任务，只在 `auditor` 名下（D30）。

版本管理子 agent（`auditor`）声明 **18 个工具**：工程上下文 4（`create_engineering_project` /
`project_status` / `project_sync` / `project_commit`）、`project_diff` 1、图谱 5（`includeIngest: true`、
`includeDrilldown: none`：`knowledge_workspace` / `knowledge_schema` / `knowledge_query` /
`knowledge_ingest` / `knowledge_update`）、只读文件 4（`read` / `read_image` / `glob` / `grep`）、
`ask_user_question`、`todo_write`、通信 2（`send_message` / `interrupt_agent`）。
它**没有** `pwsh`、TIA 原子工具、git、图谱下钻、`subagent`。
⚠️ 子 agent 调 `ask_user_question` 拿不到 answerer（宿主只为 root agent 提供），
所以"提交前问用户"由它把方案 `send_message` 给 leader、leader 去问、再把答复发回。

子 agent（`expert`）自己的 preset 只声明 **15 个**（图谱 7：`knowledge_workspace` / `knowledge_schema` /
`knowledge_query` + 四个下钻工具；`project_diff`；只读文件 2：`read` / `read_image`；检索 2：`glob` / `grep`；
通信 2：`send_message` / `interrupt_agent`；再加审批 1：`ask_user_question`（读源码前必须用它拿用户批准，D29）），
加上**宿主面仍是全局行的 1 个**（`working_directory`）= **16 个**。
git 的 12 个模型工具已从宿主行拆到 `dsh-tool-git/tools`，只挂 `leader`，所以 `expert` 与 `auditor`
都看不到它们。

两层 agent 的形态与理由见 [§8.1](#81-发行版政策层注入系统提示词) 与
[`docs/decisions.md`](docs/decisions.md) **D23**。

---

## 4. 功能是怎么实现的

### 4.1 组合机制：bundle → layer → profile

DSH 的加载分两条独立路径，**两者都靠包名**：

1. profile 清单 `dsh.profile.bundles` 里的名字 → 用于解析 bundle 目录；
2. 每个 bundle 的 `cordis.patch.yml` 里 `insert[].name` → 被当作**模块标识符**交给 cordis Loader import。

因此 `package.json` 的 `name` 与 `cordis.patch.yml` 的 `insert[].name` **必须逐字一致**
（带 `@` 的 YAML scalar 还得加引号）。本发行版里这一点长这样：

```yaml
# packages/dsh-tool-git/cordis.patch.yml      （无 scope，不需要引号）
- insert:
    - id: tool-git
      name: dsh-tool-git

# packages/dsh-tia-openness-v17-min/cordis.patch.yml
- insert:
    - id: tia-openness-v17-min
      name: '@voltarenyah/dsh-tia-openness-v17-min'
```

蓝图的 `dsh.profile.bundles` 决定**叠加顺序**（后面的层可以覆盖前面的层），
profile 自己的 `cordis.patch.yml` 是**用户层**，在所有 bundle 层之后应用：

```
dsh-base  →  dsh-web-app  →  tia-openness-v17-min  →  dsh-tool-git  →  profile/cordis.patch.yml
（基础层）    （Web 应用层）  （插件层，只插自己的行）    （插件层）        （环境相关设置写这里）
```

两个插件的 bundle patch **只插入自己的行、不带任何环境相关配置**，所以同一份 bundle
可以装在任意 profile 里；`opennessDir`、超时、`destructivePolicy` 这些归 profile 的用户层管。

### 4.2 TIA 插件：两层架构 + 白名单控制器

Openness 不能直接从 Node 调用，所以插件分成两层，中间是**一行一帧的 NDJSON 协议**：

```
┌─ DSH 宿主进程 (Node) ─────────────────────────────┐
│  dsh-tia-openness-v17-min (TypeScript)            │
│   • 注册 6 个模型可见工具                          │
│   • ctx.effect() 拥有 C# 控制器子进程              │
│   • 请求串行化 / 排队上限 / 硬超时终止与自动重启    │
│   • 传输层错误 → 结构化 ToolFailure                │
└──────────────────┬────────────────────────────────┘
                   │ NDJSON over stdin/stdout
┌──────────────────▼────────────────────────────────┐
│  TiaOpennessV17Min.Controller.exe (C#, x64,       │
│  .NET Framework 4.8)                              │
│   • 先注册 Siemens 官方程序集解析器，再惰性加载    │
│     Siemens.Engineering.dll（V17）                 │
│   • 只执行 5 个白名单操作                          │
│   • 写入 = ExclusiveAccess + Transaction + 读回验证│
│   • 任何异常 → 结构化 JSON {code, message, details}│
└───────────────────────────────────────────────────┘
```

**工具与它们的默认策略**（26 个，统一返回 `ok` / `summary` / `data` / `changes` / `diagnostics` / `error` 信封；
完整清单与参数见该包 [`README.md` §4](packages/dsh-tia-openness-v17-min/README.md) 与
[`docs/EXTENDED-SURFACE.md`](packages/dsh-tia-openness-v17-min/docs/EXTENDED-SURFACE.md)）：

| 工具组 | 工具 | 写入 | 默认 dry-run |
|---|---|---|---|
| 工程生命周期 | `open_project` | 仅当 `allow_upgrade=true` | 否（升级单独把关） |
| 块读写主线 | `export_blocks` / `compile_plc` / `close_project` / `import_blocks` | 导出只写文件；其余**是** | 导入/编译/关闭 **是**，导出否 |
| 工程数据（v0.2） | `create_project` / `save_project` / `archive_project` / `project_info` / `project_languages` / `project_texts` / `update_project` / `portal_settings` | 除 `project_info` 外都可写 | 写类除创建/保存/归档/导出文本外均 **是** |
| PLC 设备数据（v0.2） | `list_plc_objects` / `create_plc_objects` / `delete_plc_objects` / `write_tags` / `set_block_attributes` / `protect_blocks` / `generate_source` / `watch_and_force_tables` / `software_units` | 除列表与生成源文件外**是** | 除生成源外均 **是** |
| F 相关（v0.2） | `safety_status` / `set_safety_settings` / `safety_signatures` | 仅 `set_safety_settings` | 该工具 **是** |
| 诊断 | `controller_status` | 否（不启动控制器） | — |

写入链路的四道保险：

1. **dry-run 默认开**：写入类操作的 `dry_run` 默认 `true`，必须显式传 `dry_run: false`；
2. **事务**：`TiaPortal.ExclusiveAccess()` → `Transaction(project, …)`，**只有全部文件成功后**
   才 `CommitOnDispose()`，否则 dispose 即回滚；
3. **写后验证**：导出逐文件读回校验 `<Name>` 并记 SHA-256 + 写 manifest；
   导入事务提交后重新读项目块集合，逐块确认存在并对比 `ModifiedDate` / `Number` / `ProgrammingLanguage`；
4. **白名单**：控制器只接受 `controller/Protocol.cs` 的 `OperationCatalog` 里的 **25 个**操作名，
   插件侧 `src/protocol.ts` 的 `OPERATIONS` 是同一份列表（双重校验，互不信任；`npm run matrix:check`
   逐条比对）。没有任何 `eval` / `Invoke` / 反射入口。

编译报错**不是**工具错误：`state` / `errorCount` / `warningCount` / `messages` 作为数据返回，让模型据此修正。

### 4.3 Git 插件：shell-free 执行 + 策略闸门

- **无 shell 注入**：每条命令走 `execFile` + 显式参数数组，模型给的路径与提交信息永不做字符串插值；
- **机器输出**：porcelain v2、`--numstat`、`--format` 记录被解析成结构化 JSON，而不是散文；
- **闸门**：`tools/pre-execute` 监听器检查**每一次**工具调用 —— 既包括插件自己的工具
  （如 `git_commit` 带 `amend: true`），也包括 shell 类工具的**命令文本**
  （`bash` / `pwsh` / `terminal` 等），匹配 `push --force`、`reset --hard`、`clean -f`、
  `branch -D`、`rebase`、`commit --amend`、`checkout --`、`update-ref -d` 等模式。
  匹配按命令切分，不会跨 `|`、`;`、换行，所以 `git add . && git push --force` 照样被拦，
  而无辜的复合命令不会被误判。

> 这是一道**策略护栏，不是沙箱**。能跑任意代码的 agent 总能用别名、`-c` 改写或脚本绕开字符串匹配。
> 闸门的目的是让误触的破坏性命令**大声失败并给出解释**；有意为之的破坏性操作应当通过
> 配置策略（`ask` / `allow`）授权，而不是绕过闸门。

### 4.4 开发期的运行时解析（为什么仓库里不装 `@deepseek-ai/*`）

插件在运行期从 profile 的运行时解析拿到 `@deepseek-ai/*`，仓库里**刻意不把它们声明为依赖**：
公开 registry 上这条线止于 `0.1.0-rc.6`，而本仓对标的宿主是 `0.2.1-rc.2` ——
拿旧副本做类型检查或跑测试 = 对着错误的 API 面验收。

于是两个包各有一个 `link:runtime` 脚本，从**已安装 app 自己的 `resources/app.asar`**
按 `dependencies` + `peerDependencies` 求闭包（约 32–33 个包 / 8 MB / < 1 s），
解包到 `<DSH_HOME>/plugin-runtime`，再 junction 进各自的 `node_modules/@deepseek-ai/`。
`runtime.json` 记下宿主版本，宿主升级后自动重抽。抽取出来的运行时**不含 `.d.ts`**
（app 的生产构建剥掉了），所以两个包各自手写了一份 `src/dsh-runtime.d.ts` 喂 `tsc`。

---

## 5. 环境要求

| 项目 | 要求 |
|---|---|
| 操作系统 | Windows（TIA 插件仅限；在其它平台能加载，但工具调用返回 `controller_not_found`）。Git 插件跨平台 |
| Node.js | **≥ 22.19**（两个包 `engines` 都这么写）；`pnpm` 与 `dsh` 本机可不在 PATH 上 |
| DSH | 任何能加载 bundle 的版本 |
| TIA Portal | **V17**（严格绑定，不兼容 V16/V18）——仅 TIA 插件需要 |
| Openness DLL | `C:\Program Files\Siemens\Automation\Portal V17\PublicAPI\V17\Siemens.Engineering.dll` |
| .NET Framework | 4.6.1+（控制器以 **4.8** 为目标框架构建）；进程位数必须 **x64** |
| Windows 用户组 | 当前用户必须属于本地组 **`Siemens TIA Openness`**（`net localgroup "Siemens TIA Openness"`） |
| 只有重建 C# 控制器才需要 | .NET SDK + .NET Framework 4.8 targeting pack + 能访问 NuGet 源 |
| 只有重建 TS 才需要 | `pnpm install`（只装 typescript / tsdown / vitest / @types/node） |

仓库已包含两个插件的**已构建产物**（`lib/`、`controller/bin/*.exe`），安装前无需编译。

---

## 6. 快速开始

### 6.1 一条命令起独立环境（推荐）

`scripts/start-env.ps1` 把"按蓝图物化 profile + 装插件 + 起服务 + 带 token 开浏览器"收成一条命令，
并且**不碰你日常的 `~/.dsh`**（默认用自己的 `DSH_HOME=%USERPROFILE%\dsh-suite-env`，
删掉该目录即完全回退）：

```powershell
pwsh -NoProfile -File scripts\start-env.ps1
```

它做四件事：`pnpm -r build` → 按蓝图物化 profile 目录 → 把本地插件按名字链进 profile
（默认 `-Mode link`，验的是**当前工作树**；`-Mode pack` 改为 `pnpm pack` 出 tarball，验**真实交付物**）
→ 启动 `dsh --profile dsh-automation-suite --port 3092`。

**要部署哪些插件不写死在脚本里**：它读蓝图的 `dsh.profile.bundles`，
凡是能在 `packages/` 下按 `package.json` 的 `name` 匹配到的条目都算本地插件
（带 scope 与不带 scope 同一套逻辑），所以新增插件只要建目录 + 把包名写进蓝图即可，脚本无需改动。

常用开关：

```powershell
pwsh -NoProfile -File scripts\start-env.ps1 -Restart              # 端口上有旧实例就先停掉再起（开发循环）
pwsh -NoProfile -File scripts\start-env.ps1 -Port 0               # 随机端口
pwsh -NoProfile -File scripts\start-env.ps1 -Mode pack            # 验真实交付物
pwsh -NoProfile -File scripts\start-env.ps1 -DshHome C:\temp\e2e  # 换一个独立 home
pwsh -NoProfile -File scripts\start-env.ps1 -Reset -NoOpen        # 先删掉重建，且不开浏览器
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `-DshHome` | `%USERPROFILE%\dsh-suite-env` | 独立 DSH_HOME；删掉即回退 |
| `-Profile` | `dsh-automation-suite` | profile 名，同时决定用哪个蓝图 |
| `-Port` | `3092` | `0` = 系统挑空闲端口 |
| `-Mode` | `link` | `link` 验工作树 / `pack` 验 tarball |
| `-SkipBuild` | 关 | 跳过 `pnpm -r build` |
| `-Reset` | 关 | 先删 profile 目录再重建（会先请你确认） |
| `-Restart` | 关 | 端口上已有 **DeepSeek Harness** 就先停掉它；占用者是别的进程则报错退出，不误杀 |
| `-NoOpen` | 关 | 不自动打开浏览器 |

> 本机 `pnpm` 与 `dsh` 都不在 PATH 上，脚本自己从 DSH 安装目录解析
> （`$env:DSH_APP_ROOT` 可覆盖，默认 `%LOCALAPPDATA%\Programs\DeepSeek Harness`）。

### 6.2 装进日常的 `~/.dsh`

把仓库里的蓝图目录直接挂成 profile（junction，随改随生效）：

```powershell
pnpm install                     # 在 Monorepo 根：workspace:^ 把插件链进蓝图的 node_modules
cmd /c mklink /J "$env:USERPROFILE\.dsh\profiles\dsh-automation-suite" `
              "<repo>\profile\dsh-automation-suite"
dsh --profile dsh-automation-suite --dump-config     # 应看到两个插件的行
```

用完要拆，**必须**用 `cmd /c rmdir`（只删链接本身）：

```powershell
cmd /c rmdir "$env:USERPROFILE\.dsh\profiles\dsh-automation-suite"
```

### 6.3 装发布物（Monorepo 之外）

从 [Releases](https://github.com/voltarenyah/dsh-automation-suite/releases) 下载
`dsh-automation-suite-<version>.zip`，解压后**双击 `install.cmd`**（推荐；直接双击 `.ps1`
会被 Windows 的下载标记 + `RemoteSigned` 策略拦截并闪退），或在终端运行：

```powershell
pwsh -NoProfile -File install.ps1
```

它把 profile 的三件套（`package.json` / `cordis.patch.yml` / `pnpm-workspace.yaml`）复制到
**专用 home** `%USERPROFILE%\dsh-automation-suite-home\profiles\dsh-automation-suite-v<version>\`
（不是日常 `~/.dsh`），再用 DSH 自带的 pnpm 安装七个插件的 tarball（Release 资产，profile 里是
**直接 URL 依赖**，不需要 npm 账号）。同时在解压目录写下 `install.json`，记录这次用的 home 与 profile。

**双击 `start.cmd` 启动**：它读取 `install.json`、设置 `DSH_HOME`、从 3093 起自动挑一个空闲端口并打开浏览器，
不需要记 `--profile` / `--port`。可选：`start.cmd -NoOpen`、`start.cmd -Port 3093`。

为什么用专用 home：左侧 workspace 列表来自 `<DSH_HOME>\storages\workspace.json` 这份注册表，
会话、设置、模型凭据也都在 DSH_HOME 下。与 desktop 共用 `~/.dsh` 会让发布版显示 desktop 打开过的项目，
并互相回写同一份注册表；独立 home 后，发布版的 workspace 列表从空开始，只包含你在这个 App 里添加的工程。

**开发版与发布版并存**：开发版用 `dsh-automation-suite`（`scripts/start-env.ps1` 默认在隔离的
`%USERPROFILE%\dsh-suite-env` 里物化），发布版用带版本号的 profile（默认落在
`%USERPROFILE%\dsh-automation-suite-home`）；两者在 workspace、会话、设置、凭据上完全隔离，
可以同时启动（`start.cmd` 会自动错开端口）。想用一个固定名字原地升级，可显式传
`-Profile dsh-automation-suite-release -Force`——覆盖前会先备份该 profile 的 `package.json` 与
`cordis.patch.yml`。安装器**拒绝**写入 junction/symlink（避免顺链接改到别处）。

维护者生成发布目录（tarball + profile + `install.cmd` / `start.cmd` + sha256 清单）：

```powershell
node scripts/build-distribution.mjs
```

为什么不能直接 `dsh plugin add` 装整份发行版：命令只接受带 `dsh.bundle.patch` 的 **bundle**，
而蓝图声明的是 `dsh.profile.bundles`，会被拒为 `not-a-bundle`。方案对比、`ERR_PNPM_*` 两个坑、
发布与本地验收步骤见 [`docs/distribution.md`](docs/distribution.md)。七个插件本身是标准 bundle，
仍可单独 `dsh plugin --profile web add <包名或 tarball>`。

桌面图标、独立窗口与安装器属于下一阶段；设计、产物、失败处理与分阶段工作量见
[`docs/desktop-packaging.md`](docs/desktop-packaging.md)（设计定稿，尚未实施）。

### 6.4 首次进入必须自己配模型

启动后 `dsh` 会打印**带 token 的 URL** 并自动用默认浏览器打开（token 每次启动都换、不落盘，
裸地址会 401）。首次进入要去 **设置 → Models 填 API key**（或首次运行弹窗 "Add an API key to get started"）；
凭据落在该 home 的 `.credentials.yaml`，与日常 home 无关。

---

## 7. 交互使用

### 7.1 三个交互面

| 交互面 | 在哪 | 用来做什么 |
|---|---|---|
| **对话** | Web GUI 的会话输入框 | 主用法：用自然语言描述任务，模型自己选 39 个工具去执行 |
| **设置 / 插件页** | 侧边栏 Settings、Plugins | 配 API key、看已加载插件、启用/禁用插件、调配置 |
| **命令行** | `scripts/start-env.ps1`、`dsh …` | 起停环境、部署、验收（`--dump-config`） |

在 **Creator 模式**下还可以让模型自己调 `plugin_manager` 装插件：

```
plugin_manager(action: "install_bundle", target: "C:\\Users\\Ansel\\dsh-automation-suite\\packages\\dsh-tia-openness-v17-min")
```

### 7.2 对话示例

**TIA（导出 → 改 → 导入 → 编译）** —— 用户侧只需要说：

> "打开 `C:\Projects\Line1\Line1.ap17`，把所有块导出到 `C:\Projects\Line1\export`。"

> "把 `FB_Motor` 的 `<HeaderVersion>` 从 0.1 改成 0.2，导回它原来的组，然后编译验证。"

模型侧展开成的调用链（每一步都是 TIA 插件的工具之一）：

```jsonc
{ "project_path": "C:\\Projects\\Line1\\Line1.ap17" }                       // open_project
{ "output_dir": "C:\\Projects\\Line1\\export", "block_names": ["FB_Motor"] } // export_blocks
{ "import_paths": ["…\\FB_Motor.xml"] }                                      // import_blocks：默认 dry_run
{ "import_paths": ["…\\FB_Motor.xml"], "import_options": "override",
  "target_group": "999_Kautex", "dry_run": false }                           // 真导入 + 写后验证
{ "dry_run": false }                                                          // compile_plc：真编译
{ "save": true, "dry_run": false }                                            // close_project
```

**Git** —— 用户说"看看现在什么状态，把改动提交了"，模型调 `git_status` → `git_diff` → `git_stage` → `git_commit`，
拿到的是结构化 JSON 而不是散文。若它试图 `git push --force`，闸门会直接拒绝并说明理由与放行方式。

### 7.3 dry-run 与审批：写操作不会悄悄发生

- **TIA 写入默认预演**：`import_blocks` / `compile_plc` / `close_project` 不加 `dry_run: false` 时
  只返回计划（`data.ready` / `data.plan` / `data.conflicts`），项目一个字节都不动。
- **Git 破坏性操作默认拒绝**：`destructivePolicy: deny`。改成 `ask` 后走运行时的审批缝
  （`ctx.approval`），由你在界面上批准；没有挂审批服务的环境会降级回 `deny`。
- 每个工具的 `description` 里都写明了这些策略，模型直接读得到，不需要你教它。

### 7.4 随包出货的知识库：`tia-openness` skill

插件把 Siemens 官方的 Openness skill 集
（[`siemens/tia-portal-ai-extensions`](https://github.com/siemens/tia-portal-ai-extensions)，MIT）
**逐字**打进包里，注册成模型可见的**一个** skill `tia-openness`：

- 它是一张「症状 / 任务 → 该读哪个文件」的**路由表**（独占访问、事务、Simatic ML 往返、
  块组层级、编译、licensing/防火墙、线程、崩溃定位、性能……）；
- 31 个上游文件作为**资源**放在 `skills/<name>/SKILL.md`，模型按需 `read` 分段读取，
  所以知识库**不占常驻上下文**，只在真正用到时付费；
- 每个工具的 description 末尾都带一句 ``Troubleshooting: load the bundled `tia-openness` skill …``，
  会话目录里也有同名条目，模型一定会看到它。

想要模型去查这些资料，直接说"编译报错了，查一下 Openness 的排查手册"即可。

### 7.5 触发约定、停止与回退

- 说「**启动 App**」（或"起一下环境"）＝ 在仓库根执行
  `pwsh -NoProfile -File scripts\start-env.ps1 -Restart`。`-Restart` 让这条命令**永远可用**：
  端口被占就先停掉旧的 `DeepSeek Harness` 再起，所以"改完代码 → 启动 App"是一步。
- **停止**：在该实例的窗口里 `Ctrl+C`；窗口丢了就 `Stop-Process -Id <harness pid> -Force`，
  控制器会读到 stdin EOF 自行退出（用 `Get-Process TiaOpennessV17Min.Controller` 确认无残留）。
- **完全回退**：删掉独立 `DSH_HOME` 目录即可 —— 但**必须**用 `cmd /c rmdir /s /q`（见 [§14](#14-安全红线)）。

### 7.6 启动成功的判断标准

1. 控制台出现 `dsh web: http://127.0.0.1:<port>/?token=…`，且浏览器自动打开；
2. 该端口有监听（`Get-NetTCPConnection -State Listen -LocalPort 3092` → `DeepSeek Harness`）；
3. **插件真的加载了**的硬证据：出现 `TiaOpennessV17Min.Controller` 子进程
   （`Get-Process TiaOpennessV17Min.Controller`）—— 说明 `apply()` 执行过、`ctx.effect` 持有子进程。
   没看到它，就是插件没加载，别急着怀疑 TIA。

---

## 8. 配置

所有环境相关的设置都写在 **profile 的用户层** `~/.dsh/profiles/dsh-automation-suite/cordis.patch.yml`。
顶层是 loader patch 条目数组：按 `id` 覆盖 config、`disable` 某行，或 `insert` 新行。
蓝图里那份**不是**空数组了：它同时承载下面的发行版政策层，物化 profile 时会被拷进去。

### 8.1 发行版政策层（注入系统提示词）与两层 agent

`profile/dsh-automation-suite/cordis.patch.yml` 最前面那几块，把发行版规矩注入到 **system 角色**的
提示词里。**纯配置、无插件代码**，改文字不需要重新构建：

| 条目 | 作用 |
|---|---|
| `- id: system-prompt` | 覆盖全局 persona（管**非 preset** 的 agent） |
| `- id: agent-preset-registry` | 把新会话的默认 preset 指到 `leader` |
| `- insert: - id: preset-leader` | **主 agent**：内置 `standard` 的工具清单原样 + 编辑与检查面（TIA / git / `project_status` / 图谱检查面）+ 政策文本；**不含**版本工作流 |
| `- insert: - id: preset-auditor` | **版本管理（leader 派它跑慢活）**：工程上下文 4（含 `project_commit`）+ `project_diff` + 图谱 5（含 ingest）+ 只读文件 + `ask_user`/`send_message`/`todo`；无 shell、无 TIA 原子工具、无 git |
| `- insert: - id: preset-expert` | **子 agent**：只读的工程知识专家（图谱发现 + 查询 + 四个下钻工具 + 只读文件检索 + `send_message`） |
| `- id: preset-standard` … `preset-cordis` | 四个内置模式默认 `disabled: true`；它们不声明工程工具行，切过去会静默丢工具，所以选择器只保留发行版的三个 preset |

**要改政策文字，只改四处 block scalar**（全局 `personaPrefix`/`personaSuffix`、`preset-leader`
的 persona、`preset-auditor` 的 persona、`preset-expert` 的 persona）。想换成中文，写法在文件头注释里；
四个内置 preset 的禁用条目默认已生效（要恢复原生模式，删掉那四条，不推荐）。

#### 两层 agent 为什么这样切

目的只有一个：**拆上下文与拆时长**。主 agent 管对话和编辑环（开工程、导入/导出、改块、编译），
`auditor` 管版本流水线（创建、同步、差异、提交、图谱刷新）这些分钟级的活，`expert` 钻进具体代码问题，
各自在自己的窗口里推理，只有结论回流。

- **派发**：主 agent 用 `subagent` 工具派给 `expert` 或 `auditor`（`allowedAgentPresets` 就是这两个 id）。
  工具立刻返回 `started subagent <id>`，**不等待**；子 agent 结束时宿主把它的收尾文本作为一条
  notice 写回主会话。
- **用户插话**：父会话 header 的「后代数」触发器 → 目录树 → 点一行在主区打开、或点行尾箭头
  在**右侧栏分栏**打开。continuable 子会话有完整 composer，可以继续追问；追问也会回流给主 agent。
  （左侧会话列表**刻意不含**子会话，这是宿主的设计。）
- **工具面**：`expert` 看不到任何 TIA 操作工具、git、`pwsh`、工程上下文工作流，也拿不到
  `knowledge_ingest`。它的"只读"只由工具面保证——子 agent 继承父会话的显式沙箱覆盖，
  审批策略被宿主钉死 `never`，所以别指望沙箱拦它。
- **深度**：`subagent.maxDepth` 默认 1，`expert` 不能再派孙代。

实测效果（一次真实请求落盘的 `system/message`）：identity 之后紧接着就是 `personaPrefix`，
`personaSuffix` 落在提示词最末尾。

> ⚠️ **persona 文本里的 `{{...}}` 是严格插值，只有 `provider` 与 `model` 两个变量存在**
> （`dsh-agent-loop` 注册的）。写别的名字（例如 `{{cwd}}`）会让**整个回合失败**：
> `unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix"; registered variables: provider, model`。
> 工作目录本来就在 runtime context 里，persona 不必再写一遍 —— 本蓝图早期版本踩过这个坑，
> 全局与两个 preset 的 persona 现已统一改成一句话引用 runtime context。

> ⚠️ 别把这段"简化"成只留一行 `- id: system-prompt`。web 组合的 agent 一律走 preset，
> preset 内的 `dsh-persona` 行按作用域**遮蔽**全局 persona——已实测：给全局 persona 打标记，
> 该标记**不会**出现在 preset 会话的提示词里；而 `dsh-base` 的全局工具行全是 `disabled: true`，
> 真正生效的工具面就在 preset 的 `plugins` 里。机理与升级时的重生成办法见
> [profile/dsh-automation-suite/README.md](profile/dsh-automation-suite/README.md)。
>
> ⚠️ 工程工具**按 preset 分发**：宿主面只留控制器/引擎子进程与服务，模型面工具行写在 preset 里。
> 四个内置 preset 默认已禁用；若手动恢复并切过去，**TIA、工程上下文、图谱工具都不存在**——
> 这是有意的。详见 [`docs/decisions.md`](docs/decisions.md) **D23**。

### 8.2 插件配置

```yaml
# ~/.dsh/profiles/dsh-automation-suite/cordis.patch.yml
- id: tia-openness-v17-min
  config:
    opennessDir: 'C:\Program Files\Siemens\Automation\Portal V17\PublicAPI\V17'
    requestTimeoutMs: 600000        # 大项目导入/编译实测常需 10 分钟以上，默认 300000 会超时
- id: tool-git
  config:
    destructivePolicy: ask          # deny（默认）| ask | allow
    workDir: 'C:\work\my-repo'
```

**TIA 插件**（全部有默认值，整块 `config` 可以省略）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `controllerPath` | `''` | 控制器 exe 绝对路径；空 = 用包内 `controller/bin/…`。也可用环境变量 `TIA_OPENNESS_V17_MIN_CONTROLLER` |
| `opennessDir` | `''` | 传给控制器的 `--openness-dir`；空 = 控制器默认路径。控制器侧还认环境变量 `TIA_OPENNESS_V17_DIR` |
| `requestTimeoutMs` | `300000` | 单次操作硬超时；超时会**终止**控制器（Openness 无法取消），下次调用自动重启 |
| `startupTimeoutMs` | `30000` | 启动握手超时 |
| `shutdownGraceMs` | `5000` | 卸载时先关 stdin 优雅退出，超时后强杀 |
| `maxQueue` | `8` | 排队上限，超出返回 `controller_busy` |
| `logControllerOutput` | `false` | 把控制器 stdout/stderr 转发到 DSH 日志 |
| `verboseResults` | `false` | 工具结果里附带完整控制器 payload |

**Git 插件**：

| 字段 | 默认 | 说明 |
|---|---|---|
| `workDir` | `''` | 仓库发现起始目录（默认 process cwd） |
| `gitPath` | `git` | git 可执行文件 |
| `destructivePolicy` | `deny` | `deny` / `ask` / `allow` |
| `extraDestructivePatterns` | `[]` | 追加给闸门的额外大小写不敏感正则 |
| `logMaxCommits` | `20` | `git_log` 默认条数（上限 100） |
| `diffContextLines` | `3` | `git_diff` / `git_show` 的 patch 上下文行数 |

每个工具都接受可选的 `repoDir`，并在结果里报告解析出的仓库根。

> profile 的 `patchReload` 不是 `live` 时，改完配置要**重启 DSH** 才生效。

---

## 9. 仓库结构

```
packages/
  dsh-tia-openness-v17-min/        TIA Portal V17 Openness 插件（MIT）
    src/                           插件与协议实现（index/config/controller/protocol/tools/skills/errors）
    controller/                    C# 控制器（x64 / .NET Framework 4.8）
      bin/                         已构建产物 TiaOpennessV17Min.Controller.exe（+ .exe.config）
    skills/                        随包出货的 Openness 知识库：31 个上游 SKILL.md（逐字）+ 路由 skill
    test/                          node:test 套件（62 项：61 通过 / 1 跳过）
    docs/                          协议、决策记录、真实项目实测、覆盖矩阵、功能测试指南
    test-profile/                  试跑材料：三层验证指南 + 脚本，不改默认 profile
  dsh-tool-git/                    vendor 副本（上游 lxj808624/dsh-tool-git v0.1.3，MIT）
    src/tools/                     12 个 git 工具
    src/safety.ts                  tools/pre-execute 破坏性命令闸门
    tests/                         vitest 套件（33 项）
    README.md / README.zh.md       上游 README（英/中）
  dsh-engineering-context/         工程上下文插件：**已登记进蓝图；3 个工具（D22 + S2）+ 缝 B 的图谱建库（D25）**
    src/                           作用域解析、缝 A/B、证据账本、锁、shell-free git、3 个工作流工具（tsc → lib/）
    test/                          node:test 套件（73 项，假 TIA/图谱服务 + 真实运行时 schema 校验 + 真实 git 仓库）
    scripts/                       link-dsh-runtime.mjs / tsc.mjs / run-tests.mjs
    docs/                          ARCHITECTURE.md / PATH-RULES.md / decisions.md
  dsh-engineering-graph/           工程知识图谱插件：**引擎 + 协议 + 8 个工具 + knowledgeGraph 服务，已登记进蓝图**
    src/                           NDJSON 协议客户端、4 个知识工具（含本地发现工具）、knowledgeGraph 服务（tsc → lib/）
    test/                          node:test 套件（111 项，含经真实引擎的端到端与传输层故障注入）
    engine/                        C# 引擎（net8 + Microsoft.Data.Sqlite）：Simatic ML → 图 → SQLite
                                   Graph/ Parsing/ Import/ 为 vendored（命名空间拍平，见 D17）；
                                   build.ps1 构建到 engine/bin（**进 git**：引擎缺席时插件仍加载但每次调用报
                                   engine_not_found，所以随包出货才是"checkout 开箱可用"），fixtures/ 是 7 个真实 V17 导出物
    scripts/                       link-dsh-runtime.mjs / tsc.mjs / run-tests.mjs
  dsh-ui-plc-source/               右侧栏「PLC Blocks」标签页 + 宿主 pre-step 监听（提及注入），已登记进蓝图
    src/index.ts                   宿主半侧：agent/pre-step 把 @'块名' 解析成引用信息（tsc → lib/）
    src/model.ts                   纯模型：清单解析/平铺/筛选/排序/资源地址/文案/提及语法（tsc → lib/）
    src/client/                    apply(ctx) + 面板组件 + 样式（esbuild → lib/client.js，宿主认的 loader 包装）
    test/                          node:test 套件（20 项，纯模型）
    scripts/                       tsc.mjs / build.mjs / run-tests.mjs
  dsh-ui-tia-console/              输入框上方「TIA 控制台」：状态 + 打开/保存/编译/关闭/刷新（仅浏览器半侧）
    src/index.ts                   宿主半侧：空 apply()，只为让包在 Loader 里有一行
    src/client/model.js            纯事件折叠：command/tool 事件 → 控制台状态（可单测）
    src/client/TiaBar.jsx          控制台组件（状态、按钮、展开详情、秒表）
    src/client/index.jsx           注册 conversation.input.dock 占位
    test/                          node:test 套件（22 项，纯折叠 + 字典）
    scripts/                       tsc.mjs / build.mjs / run-tests.mjs
profile/
  dsh-automation-suite/            发行版的 profile 蓝图
    package.json                   dsh.profile.bundles = 组合顺序
    cordis.patch.yml               用户 patch 层（空数组，环境设置归这里）
    pnpm-workspace.yaml            与 DSH initProfile() 模板逐字一致（nodeLinker: hoisted）
scripts/
  start-env.ps1                    独立 DSH_HOME 的环境启动器
  clean-build.mjs                  只清理 lib/ dist/ 的构建产物清理器
docs/
  vision.md                        愿景：问题、三层方案、每层职责与设计原则
  architecture.md                  目标架构：接口插件族与两个工程插件的职责、边界、契约与数据流
  decisions.md                     发行版级决策记录（已定的取舍 + 待验证项）
  open-questions.md                开放问题（34 条，可直接编辑填写答复）
  roadmap.md                       路线图与现状：逐项进度、缺口、验收口径
  tool-surface.md                  工具面重设计（调研 + 提案）：现状体检、工作流清单、目标工具面与返回契约
AGENTS.md                          仓库级约定（结构与命名、危险操作红线、验收口径）
LICENSE                            本仓 MIT 许可证（原创部分）
pnpm-workspace.yaml                workspaces: packages/* + profile/*
```

---

## 10. 开发

```powershell
pnpm install              # 全仓安装
pnpm -r build             # 全仓构建
pnpm -r typecheck         # 全仓类型检查
pnpm test                 # 全仓测试
pnpm run clean:build      # 清构建产物（只碰 lib/ dist/）
```

四个插件用**两种测试运行器**，`pnpm -r test` 会把六者都跑到：

| 包 | 运行器 | 测试规模 |
|---|---|---|
| `dsh-tia-openness-v17-min` | `node:test`（`node --test test/*.test.mjs`） | 97 项：96 通过 / 1 跳过（跳过项是"控制器未构建"的降级路径） |
| `dsh-tool-git` | `vitest`（`vitest run`） | 33 项全通过 |
| `@voltarenyah/dsh-engineering-context` | `node:test`（`node scripts/run-tests.mjs`，先构建再跑） | 56 项全通过（含经假 `engineeringAccess` / 假 `knowledgeGraph` 服务的契约用例） |
| `@voltarenyah/dsh-engineering-graph` | `node:test`（`node scripts/run-tests.mjs`，先构建再跑） | 111 项全通过（含经真实引擎的端到端；引擎没构建时该项 skip 并打印构建命令） |
| `dsh-ui-plc-source` | `node:test`（`node scripts/run-tests.mjs`，先构建再跑；浏览器半侧 `.jsx` 不进 `tsc`） | 47 项全通过（纯模型 33 + 宿主 9 + 字典 5） |
| `dsh-ui-tia-console` | `node:test`（`node scripts/run-tests.mjs`，先构建再跑） | 22 项全通过（纯事件折叠 + 字典） |

单测都需要**真实的** `@deepseek-ai/*` 运行时（不是 stub）。裸 checkout 首次运行时，
两个包的测试自举会各自自动触发抽取；也可以手动：

```powershell
pnpm --filter @voltarenyah/dsh-tia-openness-v17-min run link:runtime
pnpm --filter dsh-tool-git run link:runtime
```

包内另有针对性的命令（在包目录里跑）：

```powershell
npm run check            # TIA：build + test + matrix:check + skills:check
npm run build:controller # TIA：重建 C# 控制器（需要本机 TIA V17 + NuGet 源）
npm run test:controller  # TIA：控制器自检 14 项（无需 TIA Portal）
npm run matrix:build     # TIA：重新生成 docs/coverage-matrix.html
npm run skills:build     # TIA：按 pinned commit 重新取上游知识库
```

### 几个必须知道的约定

- **不要手改生成物**：TIA 包的 `docs/coverage-matrix.html`、`skills/<上游名>/SKILL.md`、
  `skills/UPSTREAM.json` 都是生成物，改 `src/` 或控制器后要跑对应的 `:build`，否则 `:check` 会失败。
- **`tsdown` 会把能解析到的包打进产物**，所以 `dsh-tool-git` 的两个 tsdown 配置里
  `deps: { neverBundle: true }` 不能删：否则链接过运行时之后，产物会把整个宿主运行时内联进去
  （57.78 kB → 391.40 kB），插件会拿到一份私有的 `dsh-tools`。**验收口径**：`lib/index.mjs` 应约 57.78 kB。
- **`clean` 这个名字不能用**：pnpm 11 有内置子命令会遮蔽脚本，本仓叫 `clean:build`。
- 在 JS 块注释里写 glob 会截断注释（`profiles/*/node_modules` 的 `*/` 会提前结束 `/** … */`），
  写路径用 `profiles/<profile>/node_modules` 或转义。

---

## 11. 验收

**profile 组合的端到端验收**：

```powershell
dsh --profile dsh-automation-suite --dump-config
```

预期结尾出现（每个插件 3 行，7 个插件共 21 行 —— 6 个本地 + 公共的 `dsh-opencode-go`）：

```yaml
# == @voltarenyah/dsh-tia-openness-v17-min
- id: tia-openness-v17-min
  name: '@voltarenyah/dsh-tia-openness-v17-min'
# == @voltarenyah/dsh-engineering-context
- id: engineering-context
  name: '@voltarenyah/dsh-engineering-context'
# == @voltarenyah/dsh-engineering-graph
- id: engineering-graph
  name: '@voltarenyah/dsh-engineering-graph'
# == dsh-tool-git
- id: tool-git
  name: dsh-tool-git
# == dsh-ui-plc-source
- id: ui-plc-source
  name: dsh-ui-plc-source
# == dsh-ui-tia-console
- id: ui-tia-console
  name: dsh-ui-tia-console
# == dsh-opencode-go
- id: opencode-go
  name: dsh-opencode-go
```

带上 **§8.1 的政策层**后，行数见根 `AGENTS.md` §4 的权威基线表（本蓝图改成三个 preset、加上
`dsh-opencode-go` 后重测）。比官方 web 组合多出的部分包括全局 `system-prompt` 覆盖行、
`agent-preset-registry` 覆盖行、`preset-leader` 那一整块工具清单、`preset-auditor` 与
`preset-expert` 的小清单，并且多出：

```yaml
- id: agent-preset-registry
  config:
    default: leader
- id: preset-leader
  name: '@deepseek-ai/dsh-agent-preset'
- id: preset-auditor
  name: '@deepseek-ai/dsh-agent-preset'
- id: preset-expert
  name: '@deepseek-ai/dsh-agent-preset'
- id: engineering-context
  disabled: true
```

想在不改动任何环境的前提下预览政策层，用 `--patch` 叠加（`--dump-config` 不会挂载插件）：

```powershell
dsh --profile web --patch .\profile\dsh-automation-suite\cordis.patch.yml --dump-config
```

更强的一条是 `dsh --profile <p> --dump-config-schema`：输出里出现该插件的 Config 字段
（如 `opennessDir`、`destructivePolicy`），说明模块被**真实 import 并读取了 schema**。

> 注意 `--dump-config-schema` 在**未装任何插件**的官方 `web` profile 上也返回 exit 1 ——
> 那 4 条 `unrecognized Loader tree carrier` 错误落在官方 `dsh-agent-preset` 的行上
> （`/179`–`/182`），与插件无关，不要当成插件问题去查。

**装 tarball 的验收链路**：

```powershell
cd packages/<pkg>; pnpm pack
dsh plugin --profile <临时 profile> add <tarball>
dsh --profile <临时 profile> --dump-config     # 含你的插件行 = 通过了
```

**启动后的运行期验收**：见 [§7.6](#76-启动成功的判断标准)（token URL、端口监听、
`TiaOpennessV17Min.Controller` 子进程）。

---

## 12. 故障排查

TIA 排障第一步永远是让模型调：

```jsonc
{ "include_controller_output": true }   // controller_status：进程状态、exe 路径、Openness 探测、用户组、最后错误
```

| 症状 / 错误码 | 含义与处理 |
|---|---|
| `openness_unavailable` | 找不到 `Siemens.Engineering.dll`：确认 TIA Portal V17 已装，或用 `opennessDir` 指定 |
| `openness_load_failed` | DLL 存在但不可用（位数不符/依赖缺失）：确认 **x64** 与安装完整性 |
| `project_not_open` / `project_already_open` | 需要先 `open_project` / 先 `close_project` |
| `project_open_failed` | 打开失败（多为旧版本项目）：需要 `allow_upgrade` |
| `plc_software_not_found` / `plc_software_ambiguous` | 传 `device_name` / `software_name` 指定 |
| `block_not_found` | 块不存在，`details.available` 给出项目里的块清单 |
| `verification_failed` | 写后读回验证未通过（`data` 仍含已发生的写入与验证报告）—— **不要**盲目重试 |
| `transaction_failed` | 拿不到独占访问（可能有另一个 Openness 客户端在改项目） |
| `controller_not_found` | 找不到控制器 exe：`npm run build:controller` 或配 `controllerPath` |
| `controller_timeout` | 超过 `requestTimeoutMs`，控制器已被终止，**TIA 会话丢失**，下次调用自动重启；先把超时调大 |
| `controller_busy` | 排队超过 `maxQueue`：有长操作在跑，等它结束 |
| `controller_protocol_mismatch` | exe 与插件版本不匹配：用同一份仓库重新构建 |
| 端口被占用 | 换 `-Port`，或加 `-Restart` 停掉旧实例（占用者不是 DeepSeek Harness 时不会动它） |
| 裸地址 401 | 必须用 `dsh` 打印的**带 token 的 URL**；token 每次启动都换、不落盘 |
| 会话里看不到 TIA/git 工具 | 插件没加载：查 `--dump-config` 是否有对应行；`patchReload` 不是 `live` 时要重启 |

---

## 13. 已知边界

- **TIA 插件只做块、PLC 数据类型（UDT）与标签表**：`export_blocks` / `import_blocks` 用
  `categories` 选择 `blocks`（默认）/ `types` / `tag_tables`。硬件组态、在线下载/上传、比较、库、
  多用户、HMI 等**未实现**；逐条覆盖情况见 `packages/dsh-tia-openness-v17-min/docs/coverage-matrix.html`
  （391 条能力条目，随代码自动重新生成）。
- **真实项目里的块不一定都能导出**：ProDiag 语言块与 Safety(F-) 块被 TIA 直接拒绝，
  控制器逐块报告（`data.failures[]`）并继续。
- **导入必须指定块原来所在的组**（`target_group`），且"导入后重新导出"要放在编译之后；
  见 `docs/FUNCTIONAL-TEST.md` §8.5。
- **一次一个宿主进程一个 TIA Portal 会话**：不同 DSH 会话共用同一个控制器并排队。
- **超时即丢失会话**：Openness 不可取消，超时的唯一可靠处理是终止控制器；
  被强杀时**由控制器启动的 TIA Portal 进程可能仍然驻留**（它是独立进程，插件绝不杀它），
  请用 `close_project`（`close_portal: true`）正常收尾。
- **待人工验证的两项**（需要人在界面/真实环境操作）：运行中实例里的 **HMR disposer 路径**
  （界面里禁用/启用插件，看子进程被停掉并重启），以及 **V18+ 的 Openness 应用白名单**策略
  （本机 V17 未触发拦截）。详见 `docs/verification.md` §B。
- **Git 闸门是策略护栏，不是沙箱**：见 [§4.3](#43-git-插件shell-free-执行--策略闸门)。

---

## 14. 安全红线

以下每一条都有真实事故记录（见 `packages/dsh-tia-openness-v17-min/docs/ECOSYSTEM-COMPAT.md`）：

- ❌ **禁止**用 `rm -rf` / `Remove-Item -Recurse` / .NET `Directory.Delete` 等**会跟进
  junction/symlink 目标**的递归删除去清 `node_modules` 或 profile 目录。这类删除毁过源仓库的 `.git` 元数据。
- ❌ **禁止**在根 `package.json` 里声明 `@deepseek-ai/*`（或任何 DSH 运行时包）为依赖 ——
  它们由 profile 的运行时解析提供。
- ❌ **禁止**去掉根 `package.json` 的 `private`。
- ✅ 拆 junction 只用 `cmd /c rmdir "<路径>"`（只删链接本身）或 `Remove-Item -Force`（**不加** `-Recurse`）。
- ✅ 清构建产物用 `pnpm run clean:build`：它只检查 `lib/`、`dist/`，遇链接只 unlink、不下降。
- ✅ 用 `-Reset` 或手删独立 `DSH_HOME` 时**必须**用 `cmd /c rmdir /s /q`：里面 `link:` 与 pnpm 的
  junction 指向仓库和 pnpm store，跟进式递归删除会毁掉目标。
- ✅ 重新链接运行时用 `pnpm --filter <pkg> run link:runtime -- --force`：目标若是链接只 unlink，不下降。

---

## 15. 许可证与第三方

本仓整体以 **MIT** 授权（仓库根 [`LICENSE`](LICENSE)），覆盖本仓原创的部分：
`profile/` 蓝图、`scripts/` 工具与本文档。随包出货的第三方内容保留各自条款：

| 组件 | 许可证 | 说明 |
|---|---|---|
| `dsh-automation-suite`（本仓） | MIT（根 [`LICENSE`](LICENSE)） | 蓝图、Monorepo 脚本、文档；根 `package.json` 已声明 `"license": "MIT"` |
| `@voltarenyah/dsh-tia-openness-v17-min` | MIT（包内 `LICENSE`） | 本仓原创代码 |
| `dsh-tool-git` | MIT（包内 `LICENSE`） | 上游 [`lxj808624/dsh-tool-git`](https://github.com/lxj808624/dsh-tool-git) `v0.1.3`（commit `2347e3d`）的**压平 vendor 副本**；包名刻意保持上游的 `dsh-tool-git`（不加 scope），因此**不能以同名发布到 npm** |
| Siemens Openness skill 集 | MIT | 上游 [`siemens/tia-portal-ai-extensions`](https://github.com/siemens/tia-portal-ai-extensions) commit `b5c7041` 的**逐字文档副本**（31 个文件，已改代码一行未取），附上游许可证全文与逐文件 sha256 |
| Siemens NuGet 运行库 | Siemens 自有条款 | `controller/bin/` 随插件分发 **Siemens 解析器及其 5 个依赖**（约 889 KB，未做任何修改）；`Siemens.Engineering.dll` **从不被本仓分发**（引用包 `CopyLocal=false`），始终来自用户自己的 TIA Portal 安装。完整清单与合规姿态见 `packages/dsh-tia-openness-v17-min/THIRD_PARTY_NOTICES.md` |

`dsh-tool-git` 与本仓的差异（包名策略、运行期链接方式、`neverBundle`、新增脚本）记录在
`packages/dsh-tool-git/AGENTS.md`，与上游同步时的"四处保留差异"也在那里。

---

## 16. 文档索引

| 文档 | 内容 |
|---|---|
| [`docs/vision.md`](docs/vision.md) | **愿景**：PLC 项目为何对 LLM 不可达、三层方案（接入 / 语义 / 管理）各自的职责与接口、贯穿各层的设计原则、术语与非目标 |
| [`docs/architecture.md`](docs/architecture.md) | **目标架构**：接口插件族与两个工程插件的职责、期望与边界，三条正交轴，数据流，插件间契约与依赖顺序 |
| [`docs/decisions.md`](docs/decisions.md) | **决策记录（发行版级）**：已定的 12 条取舍（能力分层、workspace 模型、指纹变更识别、对象身份、图底座、工程上下文插件的状态落点…）与 5 项待验证 |
| [`docs/open-questions.md`](docs/open-questions.md) | **开放问题（34 条）**：A 部分 17 条会阻塞动手（含 A14–A17 工具面问题），B 部分 17 条影响细节与验收口径；已答 16 条 |
| [`docs/roadmap.md`](docs/roadmap.md) | **路线图与现状**：按插件逐项记录进度、缺口、验收口径 |
| [`docs/tool-surface.md`](docs/tool-surface.md) | **工具面重设计（调研 + 提案）**：现状体检（26 工具 1:1、20 行渲染上限、~14k tokens 常驻目录）、用户工作流清单、目标工具面与返回契约、从哪一步开始 |
| [`docs/ui-plugins.md`](docs/ui-plugins.md) | **Web GUI UI 插件**：客户端插件加载机制（含端到端实测）、基座模块表、座位目录、`source/` 数据面、以「工程块树」为例的落地设计与客户端打包配方 |
| [`docs/ui-plugins-plc-blocks-plan.md`](docs/ui-plugins-plc-blocks-plan.md) | **`dsh-ui-plc-source` 的实施计划与验收记录**：规格、数据面（清单平铺 + device/类型筛选）、降级、构建、接线、实测结果 |
| [`packages/dsh-ui-plc-source/README.md`](packages/dsh-ui-plc-source/README.md) | 右侧栏 **PLC Blocks** 标签页的用法、构建（tsc + esbuild）与安装位置 |
| [`packages/dsh-engineering-context/README.md`](packages/dsh-engineering-context/README.md) | 工程上下文插件的用法、配置与开发命令（**S2 已实现**：创建 + 状态 + 同步） |
| [`packages/dsh-engineering-context/docs/`](packages/dsh-engineering-context/docs/) | 该插件的设计与取舍：`ARCHITECTURE.md`（核心架构、作用域模型、版本管理、工具面）、`PATH-RULES.md`（workspace 内路径规则与账本/清单）、`decisions.md`（编号决策 D1–D26） |
| [`docs/distribution.md`](docs/distribution.md) | **公开发行与安装**：DSH 的安装面实测（`dsh plugin` 的 spec 形式、bundle 对账、patch 语义、pnpm 11 的两个错误）、三种打包方案对比、Release 发布步骤与验收记录 |
| [`docs/releases.md`](docs/releases.md) | **发布台账与流程**：已发布版本表（0.1.0–0.1.4）、tag 偏移的已知问题、版本规则、发布检查清单与常见错误 |
| [`CHANGELOG.md`](CHANGELOG.md) | **发行版版本摘要**：0.1.0–0.1.4 的能力变化；插件版本与 DSH 版本独立 |
| [`docs/desktop-packaging.md`](docs/desktop-packaging.md) | **桌面壳与打包方案（设计定稿，待实施）**：WebView2 独立窗口、预装或安装时联网下载 DSH、Inno 安装器、应用层自动更新、无签名策略、产物/目录/失败处理/验收清单与分阶段工作量 |
| [`profile/dsh-automation-suite/README.md`](profile/dsh-automation-suite/README.md) | 蓝图的组成、三种部署方式、验收方式 |
| [`packages/dsh-tia-openness-v17-min/README.md`](packages/dsh-tia-openness-v17-min/README.md) | TIA 插件的完整说明（验证状态、协议、工具、错误码、V17 API 要点） |
| [`packages/dsh-tia-openness-v17-min/docs/`](packages/dsh-tia-openness-v17-min/docs/) | `PROTOCOL.md`（线路协议权威描述）、`decisions.md`（技术取舍）、`REAL-RUN.md`（真实项目实测）、`FUNCTIONAL-TEST.md`、`verification.md`（验证清单）、`ECOSYSTEM-COMPAT.md`（生态兼容与事故记录） |
| [`packages/dsh-tool-git/README.md`](packages/dsh-tool-git/README.md) · [`README.zh.md`](packages/dsh-tool-git/README.zh.md) | git 插件的工具表、安全闸门、安装与配置 |
| [`packages/dsh-tool-git/AGENTS.md`](packages/dsh-tool-git/AGENTS.md) | 这个 vendor 副本与上游的差异、运行期链接、`neverBundle` |
| [`packages/dsh-tia-openness-v17-min/AGENTS.md`](packages/dsh-tia-openness-v17-min/AGENTS.md) | 覆盖矩阵与知识库的同步规则 |
| [`AGENTS.md`](AGENTS.md) | 仓库级约定：结构、命名、危险操作红线、验收口径 |
| [`LICENSE`](LICENSE) | 本仓 MIT 许可证；随包出货/ vendor 内容的条款归属见 [§15](#15-许可证与第三方) |
