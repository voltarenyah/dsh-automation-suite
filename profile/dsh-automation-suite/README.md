# profile/dsh-automation-suite

本发行版的 **profile 蓝图**。它不是一个 bundle，而是"一个 profile 目录应该长什么样"的声明：
物化成 `~/.dsh/profiles/dsh-automation-suite/` 之后才被 `dsh` 当作 profile 使用。

## 它包含什么

`dsh.profile.bundles` 决定组合顺序（后面的层可以覆盖前面的层）：

| 层 | 作用 |
|---|---|
| `@deepseek-ai/dsh-base` | DSH 基础层（会话、工具注册表、LLM……） |
| `@deepseek-ai/dsh-web-app` | Web 应用层 —— 没有它这个 profile 启动后没有 app 可跑 |
| `@voltarenyah/dsh-tia-openness-v17-min` | 接口插件族：TIA 控制器子进程 + `engineeringAccess` 服务（**模型面工具已拆到 `/tools` 子路径行**，见下节） |
| `@voltarenyah/dsh-engineering-context` | 工程上下文插件：`create_engineering_project` / `project_status` / `project_sync`。**没有宿主面资源**，所以宿主面这一行被 `disabled: true`，整行搬进 `leader` 与 `auditor` preset |
| `@voltarenyah/dsh-engineering-graph` | 工程知识图谱插件：C# 引擎子进程 + `knowledgeGraph` 服务（**模型面工具同样拆到 `/tools`**） |
| `dsh-tool-git` | 结构化 Git 工具族 + `gitContext` 服务 + 破坏性命令闸门（vendor 自上游 `lxj808624/dsh-tool-git` v0.1.3）。**模型面工具已拆到 `dsh-tool-git/tools`，只挂 `leader`**；`expert` / `auditor` 看不到 |
| `dsh-ui-plc-source` | **纯 UI 插件**：右侧栏多一个 **PLC Blocks** 标签页（读 `source/<device>/_manifest.json`，按 device 与 simaticType 筛选，点行打开既有文档预览）。宿主半侧是空 `apply()`，**不注册任何模型可见的东西**；必须在 `dsh-web-app` 之后，浏览器半侧才拿得到客户端座位 |
| `dsh-ui-tia-console` | **仅浏览器半侧**：会话输入框上方的 **TIA 控制台**（状态 + 打开/保存/编译/关闭/刷新五个按钮，dispatch 现有 `/tia-*` 指令）。同样不注册任何模型可见的东西 |
| `dsh-opencode-go` | **公共插件**（npm 上的第三方 bundle，不是本仓代码）：OpenCode Go 模型提供方 + 设置页。见下面的「公共插件」一节 |

`dsh-web-app` 是**超出最初清单额外加的**：只列 `dsh-base` 的话 profile 能 `--dump-config`，
但没有任何 app 可启动。官方 `web` 模板就是 `dsh-base` + `dsh-web-app`。

### 公共插件：`dsh-opencode-go`

这是本蓝图里**唯一一行不来自本仓 `packages/` 的依赖**，直接取自 npm（`publishConfig.access: public`），
和日常桌面 profile 用的是同一份东西、**同一个版本 `0.1.15`**（精确钉死，不是 `^`）。

- 它是个**标准 bundle**（manifest 里有 `dsh.bundle.patch`），所以只需 `dependencies` + `dsh.profile.bundles`
  两处；它的 `cordis.patch.yml` 自己 `insert` 一行 `id: opencode-go`。
- **固定 `0.1.15` 是有意的**：从 `0.1.16` 起上游把模型提供方 ID 从 `opencode-go` 改成了
  `dsh-opencode-go`（旧会话/旧配置里的 `provider: opencode-go` 会失效）；而上游的宿主兼容矩阵
  只验证到 `0.2.1-alpha.1`，本机宿主是 `0.2.1-rc.2` —— `0.1.15` 是桌面 profile 在这台机器上
  **实际跑通**的版本。要升级，先在一个环境里验过，再连同 `cordis.patch.yml` 里任何 `provider:` 引用一起改。
- **pnpm 11 会因为它失败一次**：它的传递依赖 `@google/genai` / `protobufjs` 带构建脚本，
  pnpm 11 把它们记成 "ignored builds" 并以 `ERR_PNPM_IGNORED_BUILDS` 让整次
  `dsh plugin install` 退出 1。`pnpm-workspace.yaml` 里的 `allowBuilds`（两项都 `false`）就是
  为它加的 —— 这两个脚本只是可选下载/生成步骤，不跑也能用。
- 它是**客户端 bundle**：Loader 行启用后宿主才会提供 `/plugins/??dsh-opencode-go/client.js`，
  页面上的设置页与用量胶囊才出现；只装依赖、不加 bundles 时**不报错但什么都不会发生**。
- 想改模型可见性/默认模型，照桌面 profile 的写法在 `cordis.patch.yml` 里加 `- id: opencode-go`
  的 `modelVisibility`、或 `- id: agent-default-model` 的 `provider/model`（本蓝图**没有**带这两项，
  默认保持「全部模型可见、默认模型不动」）。

## 三个文件

| 文件 | 说明 |
|---|---|
| `package.json` | profile 清单。`dsh.profile.bundles` 是**按包名**解析 bundle 目录的依据 |
| `cordis.patch.yml` | 用户 patch 层，在所有 bundle 层之后应用。环境相关设置（`opennessDir`、超时）写这里；发行版的行为政策也在这里（见下节） |
| `pnpm-workspace.yaml` | 由 DSH `initProfile()` 的模板改出来：`nodeLinker: hoisted` 是树外插件需要的，`allowBuilds` 是安装 `dsh-opencode-go` 的必要项（见上节） |

`dsh` 首次启动一个 profile 目录时会额外生成 `cordis.yml`（空的根 include 存根，内容写着
"Edit cordis.patch.yml, not this file"）与 `.plugin-manager/`。两者都已 gitignore，不要手改。

## 三个 preset：`leader`、`auditor` 与 `expert`

本蓝图声明三个 preset，默认（新会话）是 `leader`：

| preset | 谁用 | 工具面 |
|---|---|---|
| **`leader`** | 主 agent | 内置 `standard` 的全部工具 + 本发行版五个工程工具行（TIA 26、工程上下文 3、`project_diff`、图谱 7 `includeDrilldown: inspect`、git 12） |
| **`auditor`** | 版本管理会话 | `create_engineering_project` / `project_status` / `project_sync`、只读 `read`/`read_image`/`glob`/`grep`、`ask_user`、`todo`、`time-context`、`compaction` |
| **`expert`** | 子 agent（`subagent` 工具默认挂它） | **只读**：图谱 `knowledge_workspace` / `knowledge_schema` / `knowledge_query` + 四个下钻工具（`includeIngest: false, includeDrilldown: all`）、`project_diff`、`read`/`read_image`/`glob`/`grep`、`send_message`/`interrupt_agent`、`time-context`、`compaction` |

`auditor` **没有**：`pwsh`/`bash`、TIA 26 个原子工具、git、`knowledge_*`、`project_diff`、
`subagent`。它的职责是导入基线、判断漂移、同步 SOURCE、提交、报图谱新鲜度；**不解释块内逻辑为什么改**
（那是 Leader/Expert 的职责）。

`expert` **没有**：任何 TIA 操作工具、git、工程上下文工作流、`pwsh`、`jobs`、`schedule`、
`goal`、`plan`、`web`、`todo`、`ask_user`、`skill`。它也不掌握 `knowledge_ingest`（整库重建是
主 agent 建工程流程的一部分）。

### 工具面按 preset 分发（方案 A 的落地）

DSH 的工具可见性是**按声明作用域**解析的（`dsh-tools` 的 `view()`：继承面 = 全局层 + 作用域链上的
祖先层，再逐层过 `admits` 过滤）。所以：

- **宿主面（bundle 层）只留资源与服务**：TIA 控制器子进程、`engineeringAccess`、
  C# 引擎、`knowledgeGraph`、git 的 `gitContext` 服务与安全闸门。
- **模型面工具行由 preset 声明**：`@voltarenyah/dsh-tia-openness-v17-min/tools`、
  `@voltarenyah/dsh-engineering-graph/tools`、`dsh-tool-git/tools`。哪个 preset 写了这一行，
  它名下的 agent 才有这些工具。
- **`dsh-engineering-context` 没有宿主面资源**，所以它的行整个搬进 `leader` 与 `auditor`，
  宿主面那份 `disabled: true`（否则三个工具会落在全局层被所有 agent 继承）。

⇒ 一个会话能用哪些工程工具，取决于它的 preset。切到没有声明这些行的内置 preset
（`standard` / `minimal` / …）时，**这些工具不存在**——这是有意的，不是故障。

> ✅ `dsh-tool-git` 的 12 个模型工具已从宿主行拆到 `dsh-tool-git/tools`，只挂 `leader`；
> `auditor` / `expert` 看不到它们。宿主行保留 `gitContext` 服务与破坏性命令闸门。

### 子 agent 的"只读"靠什么保证

只有工具面这一层，**不要指望沙箱**：子 agent 继承父会话的**显式**沙箱覆盖
（本 profile 默认 `danger-full-access` 会原样继承），而审批策略被宿主钉死为 `never`
（`dsh-subagent` 的 `captureDelegatedPolicyOverrides`）——需要审批的操作自动拒绝、不会弹给用户。
所以"它写不了工程"由"它没有被授予任何 TIA 写工具"成立。

> ⚠️ **但 git 是例外**：`dsh-tool-git` 的 12 个工具仍是宿主面全局行，其中
> `git_commit` / `git_stage` / `git_checkout` / `git_stash` 能改仓库。实测要求子 agent
> 回答"你有没有 TIA 或 git 写工具"时它答的是 **yes**（指的是 git）。
> 想让它真的只读，要么把该包也拆成 `/tools` 行（第 5 处 vendor 偏离），要么接受这一点 ——
> 见 `docs/decisions.md` **D23**。

## 三个文件

| 文件 | 说明 |
|---|---|
| `package.json` | profile 清单。`dsh.profile.bundles` 是**按包名**解析 bundle 目录的依据 |
| `cordis.patch.yml` | 用户 patch 层，在所有 bundle 层之后应用。环境相关设置（`opennessDir`、超时）写这里；发行版的行为政策也在这里（见下节） |
| `pnpm-workspace.yaml` | 由 DSH `initProfile()` 的模板改出来：`nodeLinker: hoisted` 是树外插件需要的，`allowBuilds` 是安装 `dsh-opencode-go` 的必要项（见上节） |

`dsh` 首次启动一个 profile 目录时会额外生成 `cordis.yml`（空的根 include 存根，内容写着
"Edit cordis.patch.yml, not this file"）与 `.plugin-manager/`。两者都已 gitignore，不要手改。

## 发行版政策层：往系统提示词里注入发行版规矩

`cordis.patch.yml` 里的四块（全局 `system-prompt` persona、`preset-leader`、`preset-expert`、
`agent-preset-registry`）把发行版的政策文本注入到 **system 角色**的提示词里。
**纯配置，没有任何插件代码**，改文字不用重新构建。

**要改政策文本，只改文件里那三处 block scalar**（全局的 `personaPrefix`/`personaSuffix`、
`preset-leader` 的 persona、`preset-expert` 的 persona）。
文件头部注释记录了另外两种改法：把它换成中文、以及给四个内置 preset 各加一条 `disabled: true`
把政策锁死（不许切回无政策的 preset）。

### 为什么必须整份重述 `standard` 的 plugins 列表

这条最容易被"顺手简化"，改坏的方式是不报错的（工具悄悄消失），所以写在这里：

1. 系统提示词里**唯一由配置提供的文本槽位**是 persona prefix/suffix。但 web 组合的 agent 一律走
   preset，preset 内的 `dsh-persona` 行在 agent 作用域注册同名段 `deployment:persona-prefix`，
   按作用域**遮蔽**全局 `system-prompt` 的 persona
   （`dsh-scope` 的 `ScopedLayers.merge`；`dsh-persona` 包自己的注释也这么写）。
   ⇒ 只改全局那一行，对 preset 会话无效。
2. loader 的 patch 是「按 key 浅合并、`config` 整体替换」
   （`cordis-plugin-loader/src/config/entry.ts` 的 `Entry.update`），嵌套的 `config.plugins`
   **不会**按 id 合并；而 web 组合里 `dsh-base` 的全局工具行**全部 `disabled: true`**，
   真正生效的工具面就在 preset 的 `plugins` 列表里。
   ⇒ 覆盖或新建 preset 必须把 `plugins` 整份写出来；只写一个 persona 行会把该 agent 的工具全丢掉。

因此本文件里的 `preset-leader` 与上游 `standard` 的 **22 条**顶层子插件行**逐项等价**（id、name、顺序、
`disabled`/`group`/`isolate`/`config` 全部相同），只在三处不同：persona 行、id/order/名称，
以及**多出的工程工具行**（`leader-engineering-context` / `leader-tia-tools` / `leader-git-tools` /
`leader-tia-commands` / `leader-graph-tools`）。
`preset-auditor` 是版本管理的专用小清单（context 3 + 只读 fs + ask_user/todo + 压缩），
`preset-expert` 是只读知识专家的极小清单；两者都不与上游对齐——它们要的正是"少"。
升级 DSH 后上游若改了 `standard`，`preset-leader` 这份副本**不会**自动跟随，需要按文件头注释重新生成；
`preset-auditor` / `preset-expert` 只需核对它们引用的那几个包名是否还在。

### 验收

```powershell
# 组合是否成立（无副作用，不需要物化 profile）
dsh --profile web --patch .\profile\dsh-automation-suite\cordis.patch.yml --dump-config
```

预期：exit 0，且新树里出现

```yaml
- id: agent-preset-registry
  config:
    default: leader
- id: preset-leader
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: leader
    ...
          - id: persona
            config:
              prefix: |-
                You are the `leader` agent of the dsh-automation-suite distribution: ...
- id: preset-expert
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: expert
    ...
```

**两条比行数更硬的断言**（行数只用来发现"整行消失"这类事故）：

```powershell
# 1. 三个 preset 行都在
dsh --profile dsh-automation-suite --dump-config | Select-String "preset-(leader|auditor|expert)"

# 2. 工程工具的宿主面行已被禁用、工具行在 preset 里
dsh --profile dsh-automation-suite --dump-config | Select-String "engineering-context|tia-openness-v17-min/tools|engineering-graph/tools"
```

本 profile 自身（物化后）的验收：

```powershell
dsh --profile dsh-automation-suite --dump-config
```

输出以 **7 个插件行**结尾（6 个本地插件 + 公共的 `dsh-opencode-go`）。行数基线见根 `AGENTS.md` §4 的权威表
（本蓝图加上三个 preset 与 `dsh-opencode-go` 后已重测）。

> ⚠️ `start-env.ps1` 只在 profile 目录**尚不存在**时从蓝图拷贝 `cordis.patch.yml`
> （`if (-not (Test-Path $manifest))`）。所以改完蓝图后要让它生效，得 `-Reset` 重建，
> 或者手动把新内容同步进已物化的那个目录。物化目录里的 patch 是**应用会回写的活状态**
> （设置项以行形式写回），所以同步时请**追加/合并**，不要整文件覆盖。

## ⚠️ `dsh plugin add` 装不了它

`dsh plugin add` 只接受 **bundle**：插件管理器会检查manifest 里的 `dsh.bundle.patch`，
没有就拒绝并报 `not-a-bundle`。本蓝图声明的是 `dsh.profile.bundles`，用途不同，因此
**不能用 `pnpm pack` + `dsh plugin add` 来安装一个 profile**。请用下面的流程。

## 部署

### A. 本地开发（junction，随改随生效）

把仓库里的这个目录直接挂成 profile，`pnpm install` 已经通过 `workspace:^` 把插件链进了它的
`node_modules`，不需要发布：

```powershell
pnpm install                                              # 在 Monorepo 根
cmd /c mklink /J "$env:USERPROFILE\.dsh\profiles\dsh-automation-suite" `
              "<repo>\profile\dsh-automation-suite"
dsh --profile dsh-automation-suite --dump-config
```

用完要拆，**必须**用 `cmd /c rmdir`（只删链接本身）：

```powershell
cmd /c rmdir "$env:USERPROFILE\.dsh\profiles\dsh-automation-suite"
```

> ⚠️ 不要用 `Remove-Item -Recurse` / .NET `Directory.Delete` 去拆这个 junction：它们会跟进链接目标，
> 把**仓库里的这个目录**删掉。同类事故见 `packages/dsh-tia-openness-v17-min/docs/ECOSYSTEM-COMPAT.md`。

### B. 发布前的本地试用（拷贝 + tarball 覆盖）

`workspace:^` 在 Monorepo 外部无法解析（插件还没发布），所以要把依赖换成 tarball：

```powershell
# 1. 打一个自包含的解压目录
$dst = "$env:USERPROFILE\.dsh\profiles\dsh-automation-suite"
New-Item -ItemType Directory -Force $dst | Out-Null
Copy-Item .\package.json,.\cordis.patch.yml,.\pnpm-workspace.yaml $dst

# 2. 把每个 workspace:^ 换成对应 tarball 的 file: 路径（每个插件一条）
$repo = "<repo>"
$tarballs = @{
  '@voltarenyah/dsh-tia-openness-v17-min' = "$repo\packages\dsh-tia-openness-v17-min\voltarenyah-dsh-tia-openness-v17-min-0.1.0.tgz"
  'dsh-tool-git'                          = "$repo\packages\dsh-tool-git\dsh-tool-git-0.1.3.tgz"
}
$pkg = Get-Content "$dst\package.json" -Raw | ConvertFrom-Json
foreach ($name in $tarballs.Keys) {
  $pkg.dependencies.$name = "file:$($tarballs[$name] -replace '\\','/')"
}
$pkg | ConvertTo-Json -Depth 10 | Set-Content "$dst\package.json"

# 3. 装并验证
dsh plugin --profile dsh-automation-suite install
dsh --profile dsh-automation-suite --dump-config
```

这条流程已实测通过：`dsh plugin --profile dsh-automation-suite install` 由自带 pnpm（0.2.1-rc.2 上是
v11.28.5）装完，`--dump-config` exit 0 且以 7 个插件行结尾（行数基线见根 `AGENTS.md` §4）。
`dsh-opencode-go` 不用换成 tarball —— 它是公共包，保持 `"0.1.15"` 就会从 npm 解析。

> ⚠️ 第 2 步的 tarball 文件名不要硬编码 `@scope-` 前缀：`pnpm pack` 对 `@scope/name` 产出的是
> `scope-name-<version>.tgz`（剥掉 `@`、`/`→`-`），对不带 scope 的包就是 `dsh-tool-git-0.1.3.tgz`。
> 目录里可能同时躺着多个历史 tarball，脚本另行用 `packages/*/*.tgz` 取最新一个更稳。

### C. 发布之后

`pnpm pack` / `pnpm publish` 会把 `workspace:^` 重写成发布时的具体版本（已实测：
打包内的 `package.json` 变成 `"^0.1.0"`），所以发布产物里的依赖是可解析的，
消费者直接照 B 的前两步拷贝、然后 `dsh plugin --profile <name> install` 即可。

## 验收方式

```powershell
dsh --profile dsh-automation-suite --dump-config
```

预期结尾出现：

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

行数（**DSH 0.2.1-rc.2，2026-10-20 重测**）：官方 web 组合 **1183 行**；叠加本蓝图政策层 **1601 行**；
当前物化的套件 profile **1634 行**（权威表与口径见根 `AGENTS.md` §4）。
这三个数会随宿主升级、上游 preset 改动、以及增减插件而变，换版本或改蓝图后要重测。

> 注意这两条命令都是对**已物化的 profile**生效的：`--profile` 读的是
> `$DSH_HOME/profiles/dsh-automation-suite/`，不是本蓝图目录。想在不改动任何环境的前提下
> 预览政策层的效果，用上面「发行版政策层」一节里的 `--patch` 写法。

## 一个待定项

`package.json` 目前是 `"private": true`。这样 `pnpm -r publish` 会**静默跳过**它
（与你"连插件带 Profile 一起发"的设想不一致）。保留 `private` 的理由：DSH 目前没有
"从 npm 装一个 profile"的路径，发布一份 profile 清单没有消费方，而 `pnpm pack`
已经能产出依赖已重写的可分发包。若确实要发布，删掉 `private` 这一行即可。
