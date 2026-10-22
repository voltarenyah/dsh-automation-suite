# dsh-tool-git

[![npm](https://img.shields.io/npm/v/dsh-tool-git?logo=npm)](https://www.npmjs.com/package/dsh-tool-git)
[![CI](https://img.shields.io/github/actions/workflow/status/lxj808624/dsh-tool-git/ci.yml?branch=main&logo=githubactions&logoColor=white&label=CI)](https://github.com/lxj808624/dsh-tool-git/actions)
[![License](https://img.shields.io/npm/l/dsh-tool-git)](LICENSE)
[![awesome-deepseek-harness](https://img.shields.io/badge/awesome--deepseek--harness-listed-4D6BFE)](https://github.com/0xsline/awesome-deepseek-harness)
[![GitHub stars](https://img.shields.io/github/stars/lxj808624/dsh-tool-git?style=social)](https://github.com/lxj808624/dsh-tool-git)

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）开发的结构化、安全 Git 工具插件。

编码 agent 几乎每天都在用 git，但 dsh 默认只提供裸 `bash` 命令。`dsh-tool-git` 为模型提供十二个结构化工具——通过无 shell 的子进程运行器执行 `git`，返回规范的 JSON 值——并内置 `tools/pre-execute` 安全门，在破坏性 git 操作（强制推送、硬重置、rebase、amend、删除分支等）发生之前将其拦截，无论模型是通过这些工具调用，还是**通过 shell 工具**调用。

本包拆成两个入口，便于 profile 按 agent 授予工具：

| 入口 | 注册内容 |
|---|---|
| `dsh-tool-git`（宿主行） | `gitContext` 服务 + 安全门。**不注册任何模型工具。** |
| `dsh-tool-git/tools`（工具行） | 十二个 `git_*` 工具。它注入 `gitContext`，所以缺少宿主行时**根本不会加载**（fail closed）。 |

- **无 shell 注入**：所有命令通过 `execFile` + 显式参数数组执行，模型提供的路径和消息永远不会被字符串拼接进 shell。
- **机器可读输出**：porcelain v2、`--numstat`、`--format` 记录被解析为结构化 JSON，而不是文本。
- **默认安全**：破坏性操作默认被拒绝并附带原因说明，除非你选择 `ask`（审批弹窗）或 `allow`（放行）。

## 工具列表

| 工具 | 功能 |
|---|---|
| `git_status` | 工作区状态：分支、领先/落后、已暂存 / 未暂存 / 未跟踪文件 |
| `git_diff` | 逐文件增删统计、可选 unified patch、`--cached` / `rev` 基线 |
| `git_log` | 提交历史：哈希、作者、日期、主题、正文；支持 `maxCount`、`rev` 区间、`path` 过滤 |
| `git_branch` | 分支列表及上游跟踪状态（领先/落后） |
| `git_stage` | 暂存指定路径，或全部 / 仅已跟踪的修改 |
| `git_commit` | 用消息创建提交；返回哈希和统计 |
| `git_stash` | `list` / `push` / `pop` 暂存，pop 冲突安全处理 |
| `git_show` | 单次提交：元数据、逐文件统计、可选 patch |
| `git_fetch` | 从远端下载引用，不触碰工作区 |
| `git_pull` | 默认仅快进；`not-fast-forward` / `conflict` 结果结构化返回 |
| `git_remote` | 列出已配置的远端（fetch/push URL） |
| `git_checkout` | 切换分支或创建并切换（`-b`）；绝不丢弃更改 |

每个工具都在结果中返回解析后的仓库根目录。工具**不接受**仓库路径参数：每次调用都从会话工作目录（`exec.agent.session.header.cwd`）解析根目录——既不用 `process.cwd()`，也不用模型提供的路径。

## 服务 API（`gitContext`）

宿主行提供一个 cordis 服务，兄弟插件无需 import 本包或它的模型工具即可复用 git 路径解析：

```ts
const gitContext = ctx.get('gitContext')!

await gitContext.isRepository(root)     // boolean
await gitContext.repoRoot(root)         // string | null（git rev-parse --show-toplevel）
await gitContext.init(root, { initialBranch: 'main' }) // 初始化新仓库 → GitContext
await gitContext.create(root)           // 绑定到所在仓库的 GitContext
```

`create` / `init` 返回的 `GitContext`：

| 成员 | 契约 |
|---|---|
| `repoDir` | 绝对仓库根目录 |
| `run(args)` | `{ code, stdout, stderr }`；非零退出码是**数据**，不抛异常 |
| `runChecked(args)` | `{ stdout, stderr }`；非零退出码抛异常 |
| `status(paths)` | `git status --porcelain` 行，包含未跟踪文件 |
| `head()` | HEAD 哈希；未诞生分支上为 `null` |
| `commit(paths, message)` | 路径限定的 add + commit → `{ committed, hash }` |

所有 root 参数都必须显式且为绝对路径；服务绝不回退到 `process.cwd()`。
`run` / `runChecked` 还接受 `{ signal }`。

## 安全门

安全门监听 `tools/pre-execute`，检查每一次工具调用：

- **插件自身的工具** —— 例如带 `amend: true` 的 `git_commit`。
- **shell 工具** —— `bash`、`tool:bash`、`bash_persistent`、`terminal`、`tool:terminal`、`pwsh` —— 扫描其命令文本中的破坏性 git 调用，例如：

  `push --force` / `--force-with-lease` · `push --delete` · `reset --hard` ·
  `clean -f` · `branch -d/-D` · `tag -d` · `rebase` · `pull --rebase` ·
  `commit --amend` · `checkout --` / `checkout .` / `checkout -f` ·
  `switch -f` · `restore`（丢弃工作区）· `rm -r` · `update-ref -d` · `filter-branch`

  模式匹配按命令进行：不会跨越 `|`、`;` 或换行边界，因此 `git add . && git push --force` 仍会被拦截，而普通的复合命令不会被误判。

**这是策略护栏，不是沙箱。** 能运行任意代码的 agent 总有办法绕过字符串匹配（别名、`-c` 改写、脚本化）。护栏的意义在于让**意外**的破坏性调用响亮地失败并给出解释——有意的破坏性操作通过配置的策略来授权，而不是绕过护栏。

## 安装

**npm（推荐）** —— 任意目录执行：

```sh
dsh plugin --profile web add dsh-tool-git
```

**从 GitHub**（或本地目录 / tarball）：

```sh
dsh plugin --profile web add github:lxj808624/dsh-tool-git#v0.1.2
```

然后重启 `dsh --profile web`。通过 GitHub 安装时，pnpm 会要求你允许一次 `prepare` 构建脚本（参见[官方打包指南](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)）。

## 配置

所有选项均可选，默认值如下：

```yaml
# 宿主行：服务 + 安全门（不含模型工具）
- id: tool-git
  name: dsh-tool-git
  config:
    gitPath: git               # git 可执行文件
    destructivePolicy: deny    # deny | ask | allow
    extraDestructivePatterns: []  # 追加的忽略大小写正则（安全门使用）
    logMaxCommits: 20          # git_log 默认条数（上限 100）
    diffContextLines: 3        # git_diff / git_show 的 patch 上下文行数

# 工具行：十二个模型工具（自身没有配置）
- id: tool-git-tools
  name: dsh-tool-git/tools
```

**没有 `workDir`**。工具根目录来自调用会话的 cwd；`/tools` 行从宿主行的服务继承
`logMaxCommits` / `diffContextLines`，因此宿主行是唯一的配置面。

- `deny`（默认）—— 破坏性调用被拒绝，并附带模式名和原因说明。
- `ask` —— 破坏性调用走运行时的审批通道（`ctx.approval`）；未挂载审批服务时降级为 `deny`。
- `allow` —— 安全门全部放行。

## 开发

> 本目录是上游 [`lxj808624/dsh-tool-git`](https://github.com/lxj808624/dsh-tool-git) `v0.1.3` 的
> **vendor 副本**，托管在 `dsh-automation-suite` monorepo 内。插件自身的源码与测试仍是上游的；
> 差别只在开发期 `@deepseek-ai/*` 的解析方式。详见本包的 `AGENTS.md`。

前置条件：Node.js ≥ 22.19 和 pnpm。在本 monorepo 内，`@deepseek-ai/*` 运行时包**刻意不从 npm 安装**：
公开 registry 上这条线止于 `0.1.0-rc.6`，而本仓库对标的宿主发行的是更新的运行时，拿 registry 副本做
类型检查或跑测试等于**对着错误的 API 面验收**。这些包改为从**已安装 app 自己的 `resources/app.asar`**
里链接出来，与 `dsh-tia-openness-v17-min` 同一套机制：

```sh
pnpm --filter dsh-tool-git run link:runtime   # 每个 checkout 跑一次
```

测试套件首次运行时会自动完成同样的链接。

```sh
pnpm install
pnpm run typecheck   # 针对本机宿主真实发行的运行时做 tsc 检查
pnpm test            # vitest：启动插件，在临时仓库中执行真实 git
pnpm run build       # tsc 声明 + tsdown 打包（lib/index.mjs）
```

抽取出来的运行时**不含 `.d.ts`**（app 的生产构建把类型声明剥掉了），因此本插件用到的运行时 API 面
写在 `src/dsh-runtime.d.ts` 里 —— 与 `packages/dsh-tia-openness-v17-min` 的做法一致。

测试会创建一次性仓库，把插件注册到带有真实 `dsh-tools` 运行时的 Cordis 上下文上，并通过完整管线（`tools/pre-execute` → dispatch → `tools/result`）执行每个工具。

## 发布

- `package.json` 中的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，因此 `dsh plugin add` 会把插件作为 profile 层激活。
- `prepare` 运行 `tsdown --config tsdown.prepare.config.ts`，无需项目引用即可从 `src/` 转译——因此 GitHub 安装无需相邻 harness checkout 也能构建。更推荐发布预构建 tarball / npm 包，避免 pnpm 的构建脚本白名单。

## License

[MIT](LICENSE)

## 贡献者

- [taonokenshin](https://github.com/taonokenshin) — 发现并修复了 `dsh-tools` peer 解析问题（该问题在 DeepSeek Harness 0.1.0-rc.6 下会导致宿主工具调度器崩溃，见 [#1](https://github.com/lxj808624/dsh-tool-git/issues/1) / [#2](https://github.com/lxj808624/dsh-tool-git/pull/2)）。
