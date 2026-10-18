# @voltarenyah/dsh-engineering-context

DeepSeek Harness 插件（**工程上下文插件**）：把一个 **TIA Portal 工程**领进 workspace ——
另存进来、把源文件读出来、把块逻辑转译进知识图谱 —— 好让会话有"现在谈的是哪个工程、它在哪、
里面是什么"这三个事实。

> **实现状态：P0/P1 已删除，只剩一个工具（2026-10，见 [`docs/decisions.md`](decisions.md) D22）。**
> 已实现：`create_engineering_project`（另存 + 重建源文件树 + 逐设备重建 knowledge.db，默认只给计划）。
> 未实现：指纹变更检测（P2，接口插件族的 `engineeringAccess` 服务已就绪）、变更台账（P3）。
> 设计文档在 [`docs/`](docs/)：`ARCHITECTURE.md`（目标架构）、`PATH-RULES.md`（路径规则，**现行布局以它为准**）、
> `decisions.md`（技术取舍，含 D22 为什么砍掉 4 个工具，D25 为什么知识图谱这一步是软的）。

---

## 1. 它管什么

| 概念 | 来源 |
|---|---|
| **workspace** | 宿主已有的 workspace 注册表（`@deepseek-ai/dsh-workspace`）。本插件**只读**它，不新建、不改动 |
| **作用域根** | 会话的工作目录 `exec.agent.session.header.cwd` —— 宿主也用它判定会话归属 |
| **工程本身** | `<workspace>/tia/<workspace 名>/` —— TIA 另存进来的二进制工程（谁都不进 git）。目录用 workspace 名，是因为 TIA 会拿目录名给工程命名 |
| **源文件树** | `<workspace>/source/<device>/{blocks,types,tag_tables}/` —— 可读、可 diff、进 git；旁边是本插件的索引 `_dsh-engineering-context.json` |
| **知识图谱库** | `<workspace>/knowledge/<device>/<device>_knowledge.db` —— 由工程知识图谱插件（`knowledgeGraph` 服务）从上面那棵树重建，二进制、**不进 git** |

因此"新会话只能访问自己 workspace 下的工程"是**结构性**成立：每次调用都从 cwd 重新解析，
目标路径由 workspace 根 + 配置目录名 + TIA 的项目名推出来（工具参数里**没有路径**），
且任何越界路径一律拒绝（`path_outside_workspace`）。

**不再有注册表**：workspace 里"有哪些工程"由目录布局本身回答（`tia/` 与 `source/` 下有什么），
没有 `_dsh-eng/projects.json`，也没有"当前工程"指针（D22 的刻意取舍）。

## 2. 工具（1 个）

| 工具 | 干什么 | 写？ |
|---|---|---|
| `create_engineering_project` | 把 TIA **当前打开**的工程另存进 `<workspace>/tia/<workspace 名>/`，把源文件树重建到 `<workspace>/source/<device>/`，最后逐设备重建知识图谱库到 `<workspace>/knowledge/<device>/`；默认 `dry_run: true`（只给计划）。工程已经在 workspace 里时跳过另存，只刷新源文件树与图谱 | 是（TIA 写工程、接口插件写源文件、图谱插件写 `.db`、本插件只维护 `.gitignore` 里的两行） |

**dry-run 规则**：这个工具默认**只给计划**（`dry_run: true`），因为另存会把 TIA 里打开的工程搬到
workspace 副本上，是本插件唯一难以撤销的动作。要真做必须显式 `dry_run: false`。

**知识图谱这一步是软的（D25）**：它经**缝 B**（`ctx.get('knowledgeGraph')`，不 import）逐设备调用
工程知识图谱插件的 `ingestDevice`，是**全量重建**且没有增量 —— 所以"每次导出后调一次"是唯一的刷新方式。
服务缺席、引擎没构建、或引擎不可达时，结果只说"图谱未建成"，**工作流本身照常成功**（工程与源文件树
才是它承诺的东西）；引擎拒绝（`ok:false`）逐设备如实报出，含 `error.code` 与 `error.details.remediation`，
并把它 manifest 里 TIA 拒绝导出的对象转成 workflow 诊断。大工程实测约 30 s / 库约 450 MB，
所以接口插件与图谱插件各自的 `requestTimeoutMs` 都要留够（图谱那侧默认 300 s）。

**它不做的事**：不连 TIA（那是接口插件的 `engineeringAccess` 服务）、不启动 TIA 或控制器、
不打开工程、不解析 XML / 不建图（那是图谱插件的引擎）、不删任何文件、不改用户的原始工程、
不碰 git（不 init / 不 commit / 不 push）。

## 3. 目录布局（本插件写入的全部位置）

```
<workspace>/
├── tia/<workspace 名>/           # TIA 另存的工程（二进制，整个 tia/ 由本插件写进 .gitignore）
├── source/                       # 重建的源文件树（进 git）+ _dsh-engineering-context.json（索引）
│   └── <device>/{blocks,types,tag_tables}/…
├── knowledge/<device>/           # 图谱库（二进制；只忽略 *.db），由图谱插件经缝 B 写入
│   └── <device>_knowledge.db
└── .gitignore                    # 缺则创建、有则只追加 `tia/` 与 `knowledge/**/*.db*`（含 SQLite 旁挂文件），绝不重写用户内容
```

详细规则（越界校验、命名安全化、manifest 对接）见 [`docs/PATH-RULES.md`](docs/PATH-RULES.md)。

## 4. 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `tiaDirName` | `tia` | 工程本体目录（workspace 内） |
| `sourceDirName` | `source` | 源文件树目录（workspace 内） |
| `requireWorkspace` | `true` | 越界路径是否拒绝；只有测试会设 false |

两个目录名必须是**单个路径段**：含分隔符、`..`、Windows 保留字符或保留设备名
（`nul`、`com1`…）时**回退到默认值**，而不是被重新解释。

## 5. 开发

```powershell
# 裸 checkout 首次：链接宿主运行时（本包只读缓存，从不抽取）
node scripts/link-dsh-runtime.mjs

node scripts/run-tests.mjs     # 构建 + 跑 56 项测试
node scripts/tsc.mjs -p tsconfig.json          # 只构建
node scripts/tsc.mjs -p tsconfig.json --noEmit # 只做类型检查
```

- **构建形态**：`tsc` 编译到 `lib/`，测试用 `node:test`（与 `dsh-tia-openness-v17-min` 一致）。
  `lib/` 不提交。
- **依赖由 `pnpm install` 提供**（在仓库根跑一次）。`scripts/link-dsh-runtime.mjs` 只负责
  `@deepseek-ai/*`（宿主运行时）—— 它**绝不**去链 `typescript` / `@types`：那样做会让 pnpm
  无法重新链接兄弟包的 `node_modules`（实测事故见 `docs/decisions.md` P0-14）。
- **测试如何驱动 TIA 与图谱**：`test/02-create-project.test.mjs` 用一个假 `engineeringAccess`
  服务与一个假 `knowledgeGraph` 服务，断言"计划不写任何东西""先另存再导出再建图""TIA 拒绝时停在哪一步"
  "图谱缺席/引擎没构建/引擎超时不拖垮工作流""图谱拒绝逐条报出 code + remediation"
  "`.gitignore` 只追加不重写"等契约；`test/04-knowledge-graph.test.mjs` 单独驱动缝 B 的
  规范化与降级路径。真实 TIA 与真实引擎需要它们各自在线，不在这套测试里。

## 6. 边界

不做：解析 XML / 建图本身（那是工程知识图谱插件的 C# 引擎；本插件只经缝 B 触发它的
`ingestDevice`，不读它的库、不解析它的输出）、直接调用 Openness 或起控制器（TIA 接口插件）、
agent 的会话计划清单（`dsh-tool-todo`）、按轮次的文件级变更记录（宿主已有 `dsh-workspace-changes`）、
版本管理（交给用户自己的 git）。
