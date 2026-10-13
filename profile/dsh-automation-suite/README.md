# profile/dsh-automation-suite

本发行版的 **profile 蓝图**。它不是一个 bundle，而是"一个 profile 目录应该长什么样"的声明：
物化成 `~/.dsh/profiles/dsh-automation-suite/` 之后才被 `dsh` 当作 profile 使用。

## 它包含什么

`dsh.profile.bundles` 决定组合顺序（后面的层可以覆盖前面的层）：

| 层 | 作用 |
|---|---|
| `@deepseek-ai/dsh-base` | DSH 基础层（会话、工具注册表、LLM……） |
| `@deepseek-ai/dsh-web-app` | Web 应用层 —— 没有它这个 profile 启动后没有 app 可跑 |
| `@voltarenyah/dsh-tia-openness-v17-min` | 本发行版的第一个插件 |

`dsh-web-app` 是**超出最初清单额外加的**：只列 `dsh-base` 的话 profile 能 `--dump-config`，
但没有任何 app 可启动。官方 `web` 模板就是 `dsh-base` + `dsh-web-app`。

## 三个文件

| 文件 | 说明 |
|---|---|
| `package.json` | profile 清单。`dsh.profile.bundles` 是**按包名**解析 bundle 目录的依据 |
| `cordis.patch.yml` | 用户 patch 层，在所有 bundle 层之后应用。环境相关设置（`opennessDir`、超时）写这里 |
| `pnpm-workspace.yaml` | 与 DSH `initProfile()` 生成的模板逐字一致，`nodeLinker: hoisted` 是树外插件需要的 |

`dsh` 首次启动一个 profile 目录时会额外生成 `cordis.yml`（空的根 include 存根，内容写着
"Edit cordis.patch.yml, not this file"）与 `.plugin-manager/`。两者都已 gitignore，不要手改。

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

# 2. 把 workspace:^ 换成 tarball 的 file: 路径
$tgz = "<repo>\packages\dsh-tia-openness-v17-min\voltarenyah-dsh-tia-openness-v17-min-0.1.0.tgz"
$pkg = Get-Content "$dst\package.json" -Raw | ConvertFrom-Json
$pkg.dependencies.'@voltarenyah/dsh-tia-openness-v17-min' = "file:$($tgz -replace '\\','/')"
$pkg | ConvertTo-Json -Depth 10 | Set-Content "$dst\package.json"

# 3. 装并验证
dsh plugin --profile dsh-automation-suite install
dsh --profile dsh-automation-suite --dump-config
```

这条流程已实测通过：输出 **1262 行 = 官方 web 组合的 1259 行 + 插件行 3 行**，exit 0。

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
```

## 一个待定项

`package.json` 目前是 `"private": true`。这样 `pnpm -r publish` 会**静默跳过**它
（与你"连插件带 Profile 一起发"的设想不一致）。保留 `private` 的理由：DSH 目前没有
"从 npm 装一个 profile"的路径，发布一份 profile 清单没有消费方，而 `pnpm pack`
已经能产出依赖已重写的可分发包。若确实要发布，删掉 `private` 这一行即可。
