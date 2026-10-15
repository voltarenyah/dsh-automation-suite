# profile/dsh-automation-suite

本发行版的 **profile 蓝图**。它不是一个 bundle，而是"一个 profile 目录应该长什么样"的声明：
物化成 `~/.dsh/profiles/dsh-automation-suite/` 之后才被 `dsh` 当作 profile 使用。

## 它包含什么

`dsh.profile.bundles` 决定组合顺序（后面的层可以覆盖前面的层）：

| 层 | 作用 |
|---|---|
| `@deepseek-ai/dsh-base` | DSH 基础层（会话、工具注册表、LLM……） |
| `@deepseek-ai/dsh-web-app` | Web 应用层 —— 没有它这个 profile 启动后没有 app 可跑 |
| `@voltarenyah/dsh-tia-openness-v17-min` | 本发行版的第一个插件（接口插件族：与 TIA Portal 对话） |
| `@voltarenyah/dsh-engineering-context` | 工程上下文插件：作用域 + 工程注册表。排在接口插件之后，因为它要消费前者暴露的服务 |
| `dsh-tool-git` | 结构化 Git 工具族 + 破坏性命令闸门（vendor 自上游 `lxj808624/dsh-tool-git` v0.1.3） |

`dsh-web-app` 是**超出最初清单额外加的**：只列 `dsh-base` 的话 profile 能 `--dump-config`，
但没有任何 app 可启动。官方 `web` 模板就是 `dsh-base` + `dsh-web-app`。

## 三个文件

| 文件 | 说明 |
|---|---|
| `package.json` | profile 清单。`dsh.profile.bundles` 是**按包名**解析 bundle 目录的依据 |
| `cordis.patch.yml` | 用户 patch 层，在所有 bundle 层之后应用。环境相关设置（`opennessDir`、超时）写这里；发行版的行为政策也在这里（见下节） |
| `pnpm-workspace.yaml` | 与 DSH `initProfile()` 生成的模板逐字一致，`nodeLinker: hoisted` 是树外插件需要的 |

`dsh` 首次启动一个 profile 目录时会额外生成 `cordis.yml`（空的根 include 存根，内容写着
"Edit cordis.patch.yml, not this file"）与 `.plugin-manager/`。两者都已 gitignore，不要手改。

## 发行版政策层：往系统提示词里注入发行版规矩

`cordis.patch.yml` 里那三块（全局 `system-prompt` persona、`preset-suite`、`agent-preset-registry`）
把发行版的政策文本注入到 **system 角色**的提示词里。**纯配置，没有任何插件代码**，改文字不用重新构建。

**要改政策文本，只改文件里那两处 block scalar**（`personaPrefix` / `personaSuffix`）。
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

因此本文件里的 `preset-suite` 与上游 `standard` 的 32 条子插件行**逐项等价**（id、name、顺序、
`disabled`/`group`/`isolate`/`config` 全部相同），只有 persona 行与 id/order/名称不同。
升级 DSH 后上游若改了 `standard`，这份副本**不会**自动跟随，需要按文件头注释重新生成。

### 验收

```powershell
# 组合是否成立（无副作用，不需要物化 profile）
dsh --profile web --patch .\profile\dsh-automation-suite\cordis.patch.yml --dump-config
```

预期：exit 0，且新树里出现

```yaml
- id: agent-preset-registry
  config:
    default: suite
- id: preset-suite
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: suite
    ...
          - id: persona
            config:
              prefix: |-
                You are the dsh-automation-suite agent: ...
```

本 profile 自身（物化后）的验收：

```powershell
dsh --profile dsh-automation-suite --dump-config
```

输出会比政策层之前多 **252 行**（政策层在官方 web 组合上是 1268 → 1520 行），并且以三个插件行结尾。

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

这条流程已实测通过：输出 **1268 行 = 官方 web 组合的 1259 行 + 每个插件行 3 行 × 3**，exit 0。

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
# == dsh-tool-git
- id: tool-git
  name: dsh-tool-git
```

行数：**政策层之前 1268 行**（= 官方 web 组合 1259 + 每个本地插件 3 行 × 3）；
**带上政策层之后 +252 行 = 1520 行**（多出全局 `system-prompt` 覆盖行、`agent-preset-registry` 覆盖行，
以及 `preset-suite` 那一整块 ≈ 200 行的工具清单）。

> 注意这两条命令都是对**已物化的 profile**生效的：`--profile` 读的是
> `$DSH_HOME/profiles/dsh-automation-suite/`，不是本蓝图目录。想在不改动任何环境的前提下
> 预览政策层的效果，用上面「发行版政策层」一节里的 `--patch` 写法。

## 一个待定项

`package.json` 目前是 `"private": true`。这样 `pnpm -r publish` 会**静默跳过**它
（与你"连插件带 Profile 一起发"的设想不一致）。保留 `private` 的理由：DSH 目前没有
"从 npm 装一个 profile"的路径，发布一份 profile 清单没有消费方，而 `pnpm pack`
已经能产出依赖已重写的可分发包。若确实要发布，删掉 `private` 这一行即可。
