# 公开发行与安装

这份文档回答一个问题：**这套发行版怎么打包，才能让别人（没有本仓、没有 npm 账号）
用一条命令装进自己的 DeepSeek Harness？**

结论先说：

- DSH **没有**"安装一个 profile"的命令，`dsh plugin add` **只接受 bundle**，蓝图会被拒为
  `not-a-bundle`；所以"整套发行版"不能直接 `add`。
- 本仓选**profile 分发包**：把蓝图的三件套（`package.json` / `cordis.patch.yml` /
  `pnpm-workspace.yaml`）连同插件 tarball 一起发到 GitHub Release，由 `install.ps1`
  复制到 `<DSH_HOME>/profiles/dsh-automation-suite-v<version>/` 再跑该 profile 的 pnpm install。
  它保留**已经验收过的那套组合**，且不依赖 npm 账号。
- 长期更顺手的形态是**伞形 bundle（umbrella bundle）+ npm 发布**，与官方
  `@deepseek-ai/dsh-experimental-*-profile` 同一套路；它已在本地验证可行，但受两个约束
  （见 §3），因此不作为第一版交付。

本文的命令都在 DSH **0.2.1-rc.2**、pnpm **11.28.5**（DSH 自带）、Windows 上实测。

---

## 1. DSH 的安装面（实测，不是推测）

### 1.1 `dsh plugin` 是什么

`dsh plugin --profile <p> <args...>` 的帮助原文是 "forwarding the remaining arguments to pnpm
in the profile directory"——它**不是**安装器，只是带着 DSH 自带的 pnpm 在 profile 目录里执行
pnpm，然后再做一次 bundle 对账。

它接受的 spec 形式（`dsh-plugin-manager` 的 `parseInstallSpec`）：

| 形式 | 例子 |
|---|---|
| registry 包名（可带范围） | `dsh-file-claim`、`@scope/pkg@^0.2.0` |
| tarball：本地绝对路径或 http(s) URL | `D:\pkg.tgz`、`https://…/pkg.tgz` |
| git：shorthand / git URL / 托管仓库 URL | `github:user/repo`、`git+https://…` |
| 本地目录（**必须绝对路径**） | `C:\repo\packages\pkg` |

**本地目录是 `link:` 语义**：pnpm 只链目录本身，**不会装它的 dependencies**。所以
"把伞形包指到本地目录"验不出真实安装，必须 `pnpm pack` 成 tarball 或发布到 registry。

### 1.2 bundle 对账（reconcile）

pnpm 成功后，插件管理器把**本次新增的直接依赖**里声明了 `dsh.bundle.patch` 的包追加进
`dsh.profile.bundles`。三个实际后果：

- 装完必须让 `dsh plugin add` 正常退出（exit 0），否则对账不发生，依赖记了但 bundle 不生效；
- 对账只看**新增**依赖：一次失败后依赖已经写进 `package.json`，再跑会被当成"保留依赖"跳过，
  症状是"明明 add 成功，`--dump-config` 里却没有它"——先 `remove` 再 `add`；
- 普通依赖（不声明 `dsh.bundle`）只装不启用，不会成为 profile 层。

### 1.3 profile 与 bundle 是两种东西

- bundle：声明 `dsh.bundle.patch`，`dsh plugin add` 接受，会被追加为一层 patch；
- profile：声明 `dsh.profile.bundles`，只能作为 `~/.dsh/profiles/<name>/` 使用；
  `dsh plugin add` 会以 `not-a-bundle` 拒绝它（README §6.3 记过这条）。

**新 profile 的初始化模板只有 `@deepseek-ai/dsh-base`。** 本发行版的政策层要改
`system-prompt`、`agent-preset-registry` 等行，这些行来自 `@deepseek-ai/dsh-web-app`。
所以：

- profile 分发：`bundles` 里必须同时有 `dsh-base` 和 `dsh-web-app`（本仓蓝图就是这么写的）；
- 伞形 bundle：只能装进**已经含 web-app 的 profile**（`web` / `desktop` 这类），
  否则政策层会打出 `patch: entry … not found` 的警告并静默跳过（不会失败）。

### 1.4 patch 语义（与打包直接相关）

`dsh-app-boot` 的 `applyEntryPatches`：

- `- insert:` 且没有 `id` → **无条件追加**。同一个包插两次就是两行（重复 id 不会去重），
  所以伞形 bundle 不要重复插入 web-app；
- `- id: X`（非 insert）→ 找不到目标只打 warning 并继续，**不是错误**；
- 带 `name` 的 `- id:` → `name` 与目标不一致时跳过（是保护，不是 upsert）。

### 1.5 两个 pnpm 11 的硬约束

1. **`ERR_PNPM_IGNORED_BUILDS`**：依赖树里只要有一个未声明决定的构建脚本，整次 install 以 1 退出
   （包其实已装上）。触发者是 `dsh-opencode-go` 的传递依赖 `@google/genai` 与 `protobufjs`。
   解法是在 profile 的 `pnpm-workspace.yaml` 写：
   ```yaml
   allowBuilds:
     '@google/genai': false
     protobufjs: false
   ```
   这一步必须在 install **之前**做好，否则对账不跑。
2. **`ERR_PNPM_EXOTIC_SUBDEP`**：`blockExoticSubdeps` 默认开启，**子依赖**里的 URL/git 依赖会被拒。
   同一个 URL 作为 profile 的**直接依赖**则完全合法。这条决定了第一版为什么选 profile 分发：
   插件 tarball 是 profile 的直接依赖，而不是"伞形包的依赖的依赖"。

### 1.6 兼容性闸门

`evaluatePluginCompatibility` 只看两样：包自己的 `engines.dsh`（有就单独决定），否则看
`peerDependencies` 里的 `@deepseek-ai/dsh*`。不满足会拒绝安装并提示
`dsh plugin allow-version … --accept-risk`。本仓七个插件目前都没有这两类字段，等于不设闸门；
伞形包可以显式写 `engines.dsh` 来钉住宿主版本。

---

## 2. 三种打包方案

| 方案 | 用户侧命令 | 与蓝图一致 | 需要 npm 账号 | 现状 |
|---|---|---|---|---|
| **A. profile 分发包**（本仓采用） | 解压后 `pwsh -File install.ps1` | ✅ 同一份蓝图 | ❌ | 已实现并验收 |
| B. 伞形 bundle（umbrella） | `dsh plugin --profile web add <pkg>` | ⚠️ 行是复刻的，会漂移 | ✅（或允许 exotic subdeps） | 已验证原型 |
| C. npm 发布（长期） | `dsh plugin --profile web add @scope/…-profile` | ⚠️ 同 B | ✅ | 待账号 |

### 方案 A：profile 分发包（选中）

`scripts/build-distribution.mjs` 产出：

```
dist/release/<version>/
  assets/*.tgz            七个插件的 tarball（GitHub Release 资产）
  profile/package.json    直接依赖 = 每个 tarball 的 Release URL
  profile/cordis.patch.yml 政策层，逐字节复制蓝图
  profile/pnpm-workspace.yaml  nodeLinker: hoisted + allowBuilds
  install.ps1             复制三件套 → dsh plugin install → 打印启动命令
  manifest.json           版本、URL、每个资产的 sha256
```

为什么是这三个文件就够：profile 目录在 DSH 眼里就是 `package.json` + `cordis.patch.yml`
（+ 运行期生成的 `cordis.yml`）；pnpm 的配置由 `pnpm-workspace.yaml` 提供。插件 tarball 里
已经带了构建产物（`files` 白名单含 `lib/`、`controller/bin/`、`engine/bin/`），用户不需要编译。

### 方案 B：伞形 bundle（为什么不是第一版）

官方"发行版"其实就是伞形 bundle：`@deepseek-ai/dsh-experimental-inspector-profile` 是一个
声明了 `dsh.bundle.patch` 的包，依赖功能包，patch 里 `insert` 它们的行。本仓也做了原型：

- 把一个 `@voltarenyah/dsh-automation-suite-profile` 装进从 `web` 模板物化的 profile
  （原型基于当时的六插件版本），`--dump-config` **1869 行**，七个插件行（六个插件 +
  `dsh-opencode-go`）、三个 preset、`engineering-context` 的 `disabled: true` 全部就位，
  `--dump-config-schema` 里能看到 `opennessDir` / `destructivePolicy`（模块真的被 import 了）；
- 但同一份包如果依赖写成 **URL**，装的时候会被 `ERR_PNPM_EXOTIC_SUBDEP` 拒绝；
  要绕过就得在用户 profile 里把 `blockExoticSubdeps` 关掉，或把六个包发布到 npm。
- 另外它要**复刻**每个 bundle 的插入行与整份政策层，与蓝图是两份会漂移的真相。

所以它适合"npm 发布之后"的轻量安装方式，不适合当第一版。

### 方案 C：npm 发布

七个插件里六个可以按 `@voltarenyah/*` 发布；`dsh-tool-git` **不能**——上游已经占用了这个名字
和 `0.1.3` 这个版本。三条出路：

1. 改名为 `@voltarenyah/dsh-tool-git`（要同步改 `cordis.patch.yml` 的 `insert[].name`、蓝图的
   `bundles`、本仓测试；是独立决策）；
2. 保持运行时名字不变，npm 上用 URL 依赖指向它的 Release tarball（npm 允许 URL 依赖）；
3. 伞形包内部 vendoring + 要求用户关 `blockExoticSubdeps`（最不推荐）。

---

## 3. 发布步骤（方案 A）

前提：`packages/*/lib` 已构建（`pnpm -r build`；C# 产物 `controller/bin`、`engine/bin` 已进 git）。

```powershell
# 1. 生成发布目录（<version> 同时决定 tag 与默认 profile 名）
node scripts/build-distribution.mjs --version 0.1.1

# 2. 打一个便于分发的 zip（install.ps1 与 profile/ 必须在一起）
Compress-Archive -Path dist/release/0.1.1/* -DestinationPath dist/dsh-automation-suite-0.1.1.zip

# 3. 建 Release 并上传：tarball 必须在 assets 根路径下，URL 才对得上
gh release create v0.1.1 --title "dsh-automation-suite 0.1.1" --notes "…"
gh release upload v0.1.1 dist/release/0.1.1/assets/*.tgz
gh release upload v0.1.1 dist/dsh-automation-suite-0.1.1.zip
```

`profile/package.json` 里的 URL 形如
`https://github.com/voltarenyah/dsh-automation-suite/releases/download/v0.1.1/<file>.tgz`；
`--base-url` 可以把它们换成一个本地静态服务器，用于发布前自测（见 §5）。

> 升级版本时不要复用同一个 tag 覆盖资产；GitHub Release 的资产名不可重复上传。
> 改版本号 → 重新生成 → 新 tag。

---

## 4. 用户侧安装

> **双击安装**：解压后双击 `install.cmd`（推荐）。直接双击 `install.ps1` 时，文件带着
> 浏览器的下载标记（MOTW，`ZoneId=3`），而默认的 `RemoteSigned` 策略会拒绝未签名脚本，
> 窗口一闪就关——错误还没看清。`install.cmd` 用进程级 `-ExecutionPolicy Bypass` 调用脚本，
> 结束时 `pause`，不会改动机器上的执行策略。

```powershell
# 从 Release 下载 zip，解压后：默认装到 dsh-automation-suite-v<version>
pwsh -NoProfile -File install.ps1
# 安装到隔离的 home：
pwsh -NoProfile -File install.ps1 -DshHome C:\temp\dsh-home
# 用固定名字（便于原地升级）：
pwsh -NoProfile -File install.ps1 -Profile dsh-automation-suite-release
# 覆盖已存在的 profile（先备份 package.json / cordis.patch.yml）：
pwsh -NoProfile -File install.ps1 -Profile dsh-automation-suite-release -Force
```

- **默认 profile 名带版本号**（`dsh-automation-suite-v<version>`）：每次发布一个独立目录，
  装新版本不会和旧版本或开发版重名。
- 脚本只写 `<DshHome>/profiles/<Profile>/` 里的文件，然后调用 DSH 自带的 pnpm 安装插件。
  默认 home 是 `~/.dsh`（设了 `DSH_HOME` 就用它）；要完全隔离请显式传 `-DshHome`。
- **junction/symlink 一律拒绝**（即使加 `-Force`）：顺着链接写会改到它指向的目录，
  安装器只提示用 `cmd /c rmdir` 拆链接。

### 启动与端口

DSH 的 Web 服务默认监听 **3080**。如果启动报：

```
Error: listen EADDRINUSE: address already in use 127.0.0.1:3080
```

说明 3080 被别的进程占了——本机实测是 Windows 服务 **IP Helper**（`iphlpsvc`，占用者显示为
`svchost`），并不是 DSH 自己的另一个实例，关掉开发版 App 也不会释放。用 `Get-NetTCPConnection`
确认占用者：

```powershell
Get-NetTCPConnection -State Listen -LocalPort 3080 |
  ForEach-Object { Get-Process -Id $_.OwningProcess }
```

然后加 `--port` 换一个端口即可（3092–3100 在本机都空闲）：

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" `
  --profile dsh-automation-suite-v<version> --port 3093
```

`--port 0` 让系统挑空闲端口，启动后按打印的带 token URL 访问。

### 开发版与发布版并存

| 版本 | 默认 profile 名 | 默认 DSH_HOME | 怎么起 |
|---|---|---|---|
| 开发版（当前工作树） | `dsh-automation-suite` | `%USERPROFILE%\dsh-suite-env`（`start-env.ps1` 默认） | `pwsh scripts\start-env.ps1 -Restart` |
| 发布版（Release 资产） | `dsh-automation-suite-v<version>` | `%USERPROFILE%\.dsh` | `install.ps1` 后按打印的命令 |

两者名字与 home 都不同，可以同时运行（换端口即可）。开发版一直在自己的隔离 home 里，
不会被发布版覆盖；发布版按版本落在日常 home 里，各自独立。

### 升级与回退

- **并存**（推荐用于测试）：直接装新版本，得到新的 `dsh-automation-suite-v<new>`；
  旧版本 profile 原样保留，用旧的 `--profile` 名仍可启动。
- **原地升级**：给发布版一个固定名字，重复安装时加 `-Force`：
  ```powershell
  pwsh -NoProfile -File install.ps1 -Profile dsh-automation-suite-release -Force
  ```
  覆盖前会把该 profile 的 `package.json` 与 `cordis.patch.yml` 备份为 `.bak-<timestamp>`。
  模型凭据在 `<DshHome>/.credentials.yaml`，不随 profile 覆盖丢失。
- **回退**：用旧版本的 profile 名启动，或把备份文件改名回去后重跑 `dsh plugin install`。

首次进入仍需自己配模型（设置 → Models 填 API key），与普通 DSH 一致。

### 卸载

profile 目录里可能有 `link:` 与 pnpm 的 junction，**不要**用会跟进链接的递归删除：

```powershell
cmd /c rmdir /s /q "%USERPROFILE%\.dsh\profiles\dsh-automation-suite-v0.1.1"
```

---

## 5. 验收（本地已实测）

发布前不必发到 GitHub，用本地 HTTP 服务器就能验完整链路：

```powershell
node scripts/build-distribution.mjs --version 0.1.1 --base-url http://127.0.0.1:8766 --out dist/release/test
# 另开一个进程，把 assets 目录当作静态站点
python -m http.server 8766 --bind 127.0.0.1 --directory dist/release/test/0.1.1/assets

# 默认 profile 名为 dsh-automation-suite-v0.1.1
pwsh -NoProfile -File dist/release/test/0.1.1/install.ps1 -DshHome C:\temp\dsh-test
```

实测结果（DSH 0.2.1-rc.2，v0.1.1）：

| 检查 | 结果 |
|---|---|
| `install.ps1` | 退出 0，七个包 + `dsh-opencode-go` 装上；profile 为 `dsh-automation-suite-v0.1.1` |
| 与已存在的 `dsh-automation-suite` 目录并存 | 默认安装不碰它，两个 profile 同时存在 |
| `--dump-config` | **退出 0，2033 行**；8 个插件行（含 `plcsim-advanced`）、3 个 preset、`engineering-context` 为 `disabled: true`，无 `not found` / 错误 |
| `--dump-config-schema` | 退出 1（预期：preset 行的 `unrecognized Loader tree carrier`，与插件无关）；输出含 `opennessDir`、`destructivePolicy`，证明插件被真实 import |
| 显式装到已存在的 profile | 报错并提示 `-Profile` / `-Force`，不写任何文件 |
| 对 junction 加 `-Force` | 拒绝写入，链接目标里的哨兵文件未被改动 |
| 对真实 profile 加 `-Force` | 先产生 `package.json.bak-<时间>` / `cordis.patch.yml.bak-<时间>`，再安装 |
| 启动后 | `Get-Process TiaOpennessV17Min.Controller` 有进程 = TIA 插件 `apply()` 跑过（需 TIA V17） |

> 2033 行是**全新 profile** 的数字；本机日常开发 profile 的 2036 行基线多了应用回写的 3 行设置，
> 两者不要互相解释。行数只用来发现"整行消失"这类事故。

---

## 6. 已知限制

- **宿主版本耦合**：政策层里三个 preset 的工具清单是照 DSH 0.2.1-rc.2 的 `standard` 抄的。
  升级 DSH 后要按 `profile/dsh-automation-suite/cordis.patch.yml` 头部注释重新生成。
  profile 分发没有兼容性闸门（`engines.dsh` 只在 bundle 上生效）；伞形 bundle 可以补。
- **TIA 部分仅 Windows + TIA V17**，还需要 Openness DLL、.NET Framework 4.8 x64、
  当前用户在 `Siemens TIA Openness` 本地组里。git / UI 插件跨平台。
- **首次安装有网络依赖**：七个 tarball 来自 GitHub Release（约 15 MiB），
  `dsh-opencode-go` 及其依赖来自 npm。
- **默认超时**：TIA 与知识图谱插件的 `requestTimeoutMs` 默认 300000；大工程要自己调到
  900000（在 profile 的 `cordis.patch.yml` 里覆盖，或用应用的设置页）。
- **版本化 profile 会累积**：每个版本一个目录；不需要的旧版本按 §4「卸载」删掉即可。
  想只保留一个并原地升级，用固定 `-Profile` + `-Force`（会备份两个清单文件）。
- 没有自动更新检查：升级 = 装新版本（并存），或对固定名字的 profile 重跑 `install.ps1 -Force`。

---

## 7. 相关文件

- `scripts/build-distribution.mjs` — 生成发布目录与 `install.ps1`
- `profile/dsh-automation-suite/` — 蓝图（`package.json` / `cordis.patch.yml` / `pnpm-workspace.yaml`）
- `scripts/start-env.ps1` — 开发机的独立验收环境（与本文件不是一回事）
- 根 `README.md` §6 — 使用者视角的快速开始
