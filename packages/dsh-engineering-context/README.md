# @voltarenyah/dsh-engineering-context

DeepSeek Harness 插件（**工程上下文插件**）：把一个 **TIA Portal 工程**领进 workspace ——
另存进来、把源文件读出来、把块逻辑转译进知识图谱 —— 并在 TIA 改动之后，把差异同步成
**SOURCE 树的一次 git 提交**。会话因此有三个确定的事实："现在谈的是哪个工程、它在哪、它和 TIA 是否一致"。

> **实现状态（2026-10，S2 完成）。** 三个工具：
> `create_engineering_project`（另存 + 重建源文件树 + 逐设备重建 knowledge.db）、
> `project_status`（只读状态）、`project_sync`（TIA → STAGE → SOURCE → 一次提交）。
> 版本管理的口径见 [`docs/decisions.md`](decisions.md) **D26**，路径规则见
> [`docs/PATH-RULES.md`](docs/PATH-RULES.md)（**现行布局以它为准**），核心架构见
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。
> **未实现**：DRAFT / REMOTE 与逐块指纹锁（S3）、变更台账（P3）。

---

## 1. 它管什么

| 概念 | 来源 |
|---|---|
| **workspace** | 宿主已有的 workspace 注册表（`@deepseek-ai/dsh-workspace`）。本插件**只读**它，不新建、不改动 |
| **作用域根** | 会话的工作目录 `exec.agent.session.header.cwd` —— 宿主也用它判定会话归属 |
| **工程本身（TIA）** | `<workspace>/tia/<workspace 名>/` —— TIA 另存进来的二进制工程（**权威，不进 git**）。目录用 workspace 名，是因为 TIA 会拿目录名给工程命名 |
| **源文件树（SOURCE）** | `<workspace>/source/<device>/{blocks,types,tag_tables}/` —— 可读、可 diff、进 git；旁边是 `_evidence.json`（权威账本）与 `_manifest.json`（派生清单） |
| **本机临时状态** | `<workspace>/.dsh/local/` —— workspace 锁与 STAGE；同步成功或失败都清掉，**不进 git** |
| **知识图谱库** | `<workspace>/knowledge/<device>/<device>_knowledge.db` —— 由工程知识图谱插件（`knowledgeGraph` 服务）从 SOURCE 重建，二进制、**不进 git** |

因此"新会话只能访问自己 workspace 下的工程"是**结构性**成立：每次调用都从 cwd 重新解析，
目标路径由 workspace 根 + 配置目录名 + TIA 的报告推出来（工具参数里**没有目标路径**），
且任何越界路径一律拒绝（`path_outside_workspace`）。

**不再有注册表**：workspace 里"有哪些工程"由目录布局本身回答（`tia/` 与 `source/` 下有什么），
没有 `_dsh-eng/projects.json`，也没有"当前工程"指针（D22 的刻意取舍）。

## 2. 工具（3 个）

| 工具 | 干什么 | 写？ |
|---|---|---|
| `create_engineering_project` | 把 TIA **当前打开**的工程另存进 `<workspace>/tia/<workspace 名>/`，把源文件树重建到 `<workspace>/source/<device>/`，逐设备写 `_evidence.json` + `_manifest.json`（`adoptExisting`：校验已有文件并收编，不再导出第二遍），逐设备重建知识图谱库，最后写入基线提交；默认 `dry_run: true`（只给计划）。工程已经在 workspace 里时跳过另存，只刷新源文件树与图谱 | 是（TIA 写工程、接口插件写源文件、图谱插件写 `.db`、本插件维护 `.gitignore`/`.gitattributes`、必要时的 `git init` 与基线提交） |
| `project_status` | 只读报告：哪个 PLC、账本/清单在不在、git 看到什么、锁有没有被占，并给出 `nextAction`（`open_project` / `compile` / `sync` / `commit` / `git_init` / `clean`）。`verify: true` 才读 checksum（约 3 s），否则明确标 **NOT CHECKED**；`data.wouldSync` / `data.syncReason` 只在真的读到 checksum 时下结论（`no-evidence` / `no-manifest` / `checksum-differs` / `in-sync`，读不到时 `null` / `unavailable`，未验证时 `null` / `not-checked`），成功读到的 checksum 同时写入 30 s 进程内缓存 | 否 |
| `project_sync` | 让 SOURCE 与 TIA 对齐：checksum 快路径 → 需要时慢路径扫描 → 只把差异提升进 SOURCE → 写账本/清单 → 提交该 device 目录。默认只读 checksum 并报告 `wouldSync`；计划命中上一个只读调用写入的缓存时不再读 TIA，并标 `checksumCached: true`；`dry_run: false` 永不用缓存做决定、总是重新扫描。写盘必须 `dry_run: false` | 是（SOURCE + `.dsh/local/stage` + 一次 git commit） |

**版本管理怎么判断"变没变"**：

1. **PLC 级 checksum**（`PlcChecksumProvider.Software`）是快路径：与账本一致、且账本/清单可用 →
   `unchanged`（不枚举、不导出，实测 1.6–3.0 s）。
2. 不一致才走慢路径：控制器遍历全部块/类型/标签表，用**分面指纹**（块、UDT）与
   **归一化 XML 哈希**（标签表）逐对象比对，只把差异导出到 STAGE。
3. 账本 `_evidence.json` 是**权威**：对象消失写墓碑、同步时删旧 XML；`unexportable` 的对象保留旧文件。
4. 清单 `_manifest.json` 是**派生**：只描述磁盘上的文件（bytes / sha256 / 类型元数据），
   **绝不拿它的 sha256 当变更键**（TIA 导出的 XML 带 `<Created>`，重新导出就会变）。

**提交**：`project_sync` 的提交路径限定 `source/<device>`，提交信息带 `Tia-Op: sync` / `Tia-Checksum` /
`Tia-State` / `Tia-Manifest: rebuilt|updated` 四个 trailer。`project_sync` / `project_status` **从不
`git init`**：仓库不存在时 `repository_not_found` 并让用户自己建。`create_engineering_project` 是唯一的
例外：workspace 没有仓库时它初始化一个（`git init -b main`）并提交一次基线（`Tia-Op: create`，
路径恰好 `.gitignore` / `.gitattributes` / `source`）；但 workspace 位于别人的仓库里、或根目录的仓库
不是本插件建的（无 `Tia-Op: create` trailer 且无 `.dsh/local/repo.json` 标记）时，它以
`workspace_is_repository` 拒绝。任何工具都从不 `push` / `reset` / `--force`。

**dry-run 规则**：两个写工具都默认只给计划。`create_engineering_project` 的另存是本插件唯一难以撤销的
动作；`project_sync` 会写文件并提交历史。要真做必须显式 `dry_run: false`。

**checksum 缓存（30 s，仅进程内）**：`project_status(verify: true)` 成功后把 checksum 写进一份
按 **workspace + device + software** 键控的内存缓存；紧随其后的 `project_sync` 默认计划直接复用，
不再付第二次 TIA 往返，并在 payload 里给出 `data.checksumCached: true`。缓存**只服务计划**：
`dry_run: false` 永远重新扫描、从不拿缓存决定要写什么，成功后把扫描结果写回缓存；进程退出即丢失，
不落盘。因此缓存最坏只会让"计划"在 30 s 内看到略旧的答案，真实同步不会。

**知识图谱这一步是软的（D25）**：它经**缝 B**（`ctx.get('knowledgeGraph')`，不 import）逐设备调用
`ingestDevice`，是**全量重建**且没有增量。服务缺席、引擎没构建、或引擎不可达时，结果只说"图谱未建成"，
**工作流本身照常成功**；引擎拒绝（`ok:false`）逐设备如实报出，含 `error.code` 与
`error.details.remediation`。大工程实测约 30 s / 库约 450 MB。

**它不做的事**：不连 TIA（那是接口插件的 `engineeringAccess` 服务）、不启动 TIA 或控制器、
不打开工程、不解析 XML / 不建图（那是图谱插件的引擎）、不删用户的原始工程、不碰 DRAFT/REMOTE。

## 3. 目录布局（本插件写入的全部位置）

```
<workspace>/
├── tia/<workspace 名>/           # TIA 另存的工程（二进制，整个 tia/ 写进 .gitignore）
├── source/                       # 重建的源文件树（进 git）+ _dsh-engineering-context.json（索引）
│   └── <device>/
│       ├── blocks|types|tag_tables/…
│       ├── _evidence.json        # 权威账本：指纹/归一化哈希/checksum/墓碑（进 git）
│       └── _manifest.json        # 派生清单：文件字节数/sha256/类型元数据（进 git）
├── knowledge/<device>/           # 图谱库（二进制；只忽略 *.db*），由图谱插件经缝 B 写入
│   └── <device>_knowledge.db
├── .dsh/local/                   # 锁 + STAGE（本机临时状态，不进 git）
└── .gitignore                    # 缺则创建、有则只追加 tia/、knowledge/**/*.db*、.dsh/local/
```

详细规则（越界校验、命名安全化、账本/清单字段）见 [`docs/PATH-RULES.md`](docs/PATH-RULES.md) §2。

## 4. 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `tiaDirName` | `tia` | 工程本体目录（workspace 内） |
| `sourceDirName` | `source` | 源文件树目录（workspace 内） |
| `stateDirName` | `.dsh` | 本机临时状态目录；锁与 STAGE 在 `<stateDirName>/local/` |
| `requireWorkspace` | `true` | 越界路径是否拒绝；只有测试会设 false |

三个目录名必须是**单个路径段**：含分隔符、`..`、Windows 保留字符或保留设备名
（`nul`、`com1`…）时**回退到默认值**，而不是被重新解释。

## 5. 开发

```powershell
# 裸 checkout 首次：链接宿主运行时（本包只读缓存，从不抽取）
node scripts/link-dsh-runtime.mjs

node scripts/run-tests.mjs     # 构建 + 跑 77 项测试
node scripts/tsc.mjs -p tsconfig.json          # 只构建
node scripts/tsc.mjs -p tsconfig.json --noEmit # 只做类型检查
```

- **构建形态**：`tsc` 编译到 `lib/`，测试用 `node:test`（与 `dsh-tia-openness-v17-min` 一致）。
  `lib/` 不提交。
- **依赖由 `pnpm install` 提供**（在仓库根跑一次）。`scripts/link-dsh-runtime.mjs` 只负责
  `@deepseek-ai/*`（宿主运行时）—— 它**绝不**去链 `typescript` / `@types`（实测事故见
  `docs/decisions.md` P0-14）。
- **测试如何驱动 TIA、git 与图谱**：`test/02` 用假 `engineeringAccess` / `knowledgeGraph` 服务驱动创建
  工作流；`test/04` 单独驱动缝 B 的规范化与降级；**`test/09` 用真实临时 git 仓库 + 真实 STAGE 文件**，
  假服务只负责返回 `SyncScan` 结果，断言：计划不写任何东西、checksum 漂移、未编译、
  `status(verify:true)` → 计划只读一次 checksum 且标 `checksumCached: true`、`verify:false` 不给
  `wouldSync` 结论、真实同步仍扫描并刷新缓存、缓存 TTL 到期（用 `now` 参数，不 sleep）、
  首同步提交与四个 trailer、`unchanged` 不提交、墓碑删文件而 `unexportable` 保留、
  损坏账本重建、非仓库拒绝、锁被占、失败也清 STAGE。真实 TIA 与真实引擎不在这套测试里。

## 6. 边界

不做：解析 XML / 建图本身（工程知识图谱插件的 C# 引擎；本插件只经缝 B 触发它的 `ingestDevice`，
不读它的库、不解析它的输出）、直接调用 Openness 或起控制器（TIA 接口插件）、agent 的会话计划清单
（`dsh-tool-todo`）、按轮次的文件级变更记录（宿主已有 `dsh-workspace-changes`）。
**版本管理交给用户自己的 git**：本插件只保证 SOURCE 与 TIA 一致、并为每次同步做一次可审阅的提交，
不发明版本号、不建远端、不推分支。
