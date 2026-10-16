# @voltarenyah/dsh-engineering-context

DeepSeek Harness 插件（**工程上下文插件**）：把一个 **TIA Portal 工程**领进 workspace ——
另存进来、把源文件读出来 —— 好让会话有"现在谈的是哪个工程、它在哪"这个事实。

> **实现状态：P0/P1 已删除，只剩一个工具（2026-10，见 [`docs/decisions.md`](decisions.md) D22）。**
> 已实现：`create_engineering_project`（另存 + 重建源文件树，默认只给计划）。
> 未实现：指纹变更检测（P2，接口插件族的 `engineeringAccess` 服务已就绪）、变更台账（P3）。
> 设计文档在 [`docs/`](docs/)：`ARCHITECTURE.md`（目标架构）、`PATH-RULES.md`（路径规则，**现行布局以它为准**）、
> `decisions.md`（技术取舍，含 D22 为什么砍掉 4 个工具）。

---

## 1. 它管什么

| 概念 | 来源 |
|---|---|
| **workspace** | 宿主已有的 workspace 注册表（`@deepseek-ai/dsh-workspace`）。本插件**只读**它，不新建、不改动 |
| **作用域根** | 会话的工作目录 `exec.agent.session.header.cwd` —— 宿主也用它判定会话归属 |
| **工程本身** | `<workspace>/tia/<项目名>/` —— TIA 另存进来的二进制工程（谁都不进 git） |
| **源文件树** | `<workspace>/source/<项目名>/<device>/{blocks,types,tag_tables}/` —— 可读、可 diff、进 git |

因此"新会话只能访问自己 workspace 下的工程"是**结构性**成立：每次调用都从 cwd 重新解析，
目标路径由 workspace 根 + 配置目录名 + TIA 的项目名推出来（工具参数里**没有路径**），
且任何越界路径一律拒绝（`path_outside_workspace`）。

**不再有注册表**：workspace 里"有哪些工程"由目录布局本身回答（`tia/` 与 `source/` 下有什么），
没有 `_dsh-eng/projects.json`，也没有"当前工程"指针（D22 的刻意取舍）。

## 2. 工具（1 个）

| 工具 | 干什么 | 写？ |
|---|---|---|
| `create_engineering_project` | 把 TIA **当前打开**的工程另存进 `<workspace>/tia/<项目名>/`，再把它的源文件树重建到 `<workspace>/source/<项目名>/`；默认 `dry_run: true`（只给计划）。工程已经在 workspace 里时跳过另存，只刷新源文件树 | 是（TIA 写工程、接口插件写源文件、本插件只追加一行 `.gitignore`） |

**dry-run 规则**：这个工具默认**只给计划**（`dry_run: true`），因为另存会把 TIA 里打开的工程搬到
workspace 副本上，是本插件唯一难以撤销的动作。要真做必须显式 `dry_run: false`。

**它不做的事**：不连 TIA（那是接口插件的 `engineeringAccess` 服务）、不启动 TIA 或控制器、
不打开工程、不删任何文件、不改用户的原始工程、不碰 git（不 init / 不 commit / 不 push）。

## 3. 目录布局（本插件写入的全部位置）

```
<workspace>/
├── tia/<项目名>/                 # TIA 另存的工程（二进制，整个 tia/ 由本插件写进 .gitignore）
├── source/<项目名>/<device>/     # 重建的源文件树（进 git）
│   ├── blocks/<组>/<块名>.xml
│   ├── types/<组>/<类型名>.xml
│   └── tag_tables/<表名>.xml
└── .gitignore                    # 缺则创建、有则只追加一行 `tia/`，绝不重写用户内容
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

node scripts/run-tests.mjs     # 构建 + 跑 29 项测试
node scripts/tsc.mjs -p tsconfig.json          # 只构建
node scripts/tsc.mjs -p tsconfig.json --noEmit # 只做类型检查
```

- **构建形态**：`tsc` 编译到 `lib/`，测试用 `node:test`（与 `dsh-tia-openness-v17-min` 一致）。
  `lib/` 不提交。
- **依赖由 `pnpm install` 提供**（在仓库根跑一次）。`scripts/link-dsh-runtime.mjs` 只负责
  `@deepseek-ai/*`（宿主运行时）—— 它**绝不**去链 `typescript` / `@types`：那样做会让 pnpm
  无法重新链接兄弟包的 `node_modules`（实测事故见 `docs/decisions.md` P0-14）。
- **测试如何驱动 TIA**：`test/02-create-project.test.mjs` 用一个假 `engineeringAccess` 服务，
  断言"计划不写任何东西""先另存再导出""TIA 拒绝时停在哪一步""`.gitignore` 只追加"等契约；
  真实 TIA 需要 TIA Portal 在线，不在这套测试里。

## 6. 边界

不做：解析 XML / 建图（工程知识图谱插件）、直接调用 Openness 或起控制器（TIA 接口插件）、
agent 的会话计划清单（`dsh-tool-todo`）、按轮次的文件级变更记录（宿主已有 `dsh-workspace-changes`）、
版本管理（交给用户自己的 git）。
