# @voltarenyah/dsh-engineering-context

DeepSeek Harness 插件（**插件族 2 · 工程上下文管理**）：在一个 workspace 里管住
**"现在谈的是哪个工程、哪一版"**，并维护该 workspace 的**工程注册表**。

> **实现状态：P0 已完成。**
> 已实现：作用域解析、工程注册表、3 个工作流工具。
> 未实现：版本层（P1）、指纹变更检测（P2，需要族 1 的服务缝）、变更台账（P3）。
> 设计文档在 [`docs/`](docs/)：`ARCHITECTURE.md`（核心架构）、`PATH-RULES.md`（路径规则）、
> `decisions.md`（技术取舍，含 P0 实现期的决定）。

---

## 1. 它管什么

| 概念 | 来源 |
|---|---|
| **workspace** | 宿主已有的 workspace 注册表（`@deepseek-ai/dsh-workspace`）。本插件**只读**它，不新建、不改动 |
| **作用域根** | 会话的工作目录 `exec.agent.session.header.cwd` —— 宿主也用它判定会话归属 |
| **工程** | 本插件的注册表：`<workspace>/_dsh-eng/projects.json` |
| **当前工程** | 该注册表里的 `current` 字段（唯一指针，避免两个指针互相矛盾） |

因此"新会话只能访问自己 workspace 下的工程"是**结构性**成立：每次调用都从 cwd 重新解析，
且任何越界路径一律拒绝（`path_outside_workspace`）。

## 2. 工具（3 个）

| 工具 | 回答什么问题 | 写？ |
|---|---|---|
| `eng_status` | 我在哪个 workspace / 哪个工程 / 哪个版本？路径存在吗？这个构建有哪些能力？ | 否 |
| `eng_project` | `list` / `register` / `adopt`（把源 `.ap17` 复制成工作副本）/ `forget`（只注销，不删文件） | 是 |
| `eng_scope` | `select` / `clear`：显式切换"当前工程"（D5 要求显式、可追溯） | 是（仅指针） |

**dry-run 规则**（刻意不统一）：**加信息**（`list` / `register`）立即生效，因为 `forget` 可撤销；
**删或覆盖信息**（`adopt`、`forget`）默认 `dry_run: true`，需要显式 `dry_run: false`。

## 3. 目录布局（本插件写入的全部位置）

```
<workspace>/
├── _dsh-eng/
│   ├── projects.json              # 工程注册表（唯一指针 current）
│   └── <project-id>/              # 该工程的插件状态（P2/P3：指纹基线、变更集、变更台账）
└── projects/<project-id>/
    ├── work/<name>.ap17           # 工作副本（adopt 写入；之后由 TIA 改）
    └── export/                    # 导出物（P2，由族 1 写入）
```

源 `.ap17` **只被读取一次**（`adopt` 的字节复制），此后永不读写。
详细规则见 [`docs/PATH-RULES.md`](docs/PATH-RULES.md)。

## 4. 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `projectsDirName` | `projects` | 工程内容目录（workspace 内） |
| `stateDirName` | `_dsh-eng` | 插件状态目录（workspace 内） |
| `requireWorkspace` | `true` | 越界路径是否拒绝；只有测试会设 false |

两个目录名必须是**单个路径段**：含分隔符、`..`、Windows 保留字符或保留设备名
（`nul`、`com1`…）时**回退到默认值**，而不是被重新解释。

## 5. 开发

```powershell
# 裸 checkout 首次：链接宿主运行时 + 构建/类型检查所需的包
node scripts/link-dsh-runtime.mjs

node scripts/run-tests.mjs     # 构建 + 跑 37 项测试
node scripts/tsc.mjs -p tsconfig.json          # 只构建
node scripts/tsc.mjs -p tsconfig.json --noEmit # 只做类型检查
```

- **构建形态**：`tsc` 编译到 `lib/`，测试用 `node:test`（与 `dsh-tia-openness-v17-min` 一致）。
  `lib/` 目前**不提交**（见 `docs/decisions.md` P0-2）。
- **依赖由 `pnpm install` 提供**（在仓库根跑一次）。`scripts/link-dsh-runtime.mjs` 只负责
  `@deepseek-ai/*`（宿主运行时）—— 它**绝不**去链 `typescript` / `@types`：那样做会让 pnpm
  无法重新链接兄弟包的 `node_modules`（实测事故与教训见 `docs/decisions.md` P0-14）。
- `scripts/link-dsh-runtime.mjs` **从不抽取**运行时缓存 —— 那个目录在仓库之外、无法用 git 恢复。

## 6. 边界

不做：解析 XML / 建图（族 3）、直接调用 Openness 或起控制器（族 1）、
agent 的会话计划清单（`dsh-tool-todo`）、按轮次的文件级变更记录（宿主已有 `dsh-workspace-changes`）、
把原始 git 暴露给模型。写入工程的唯一通道始终是族 1。
