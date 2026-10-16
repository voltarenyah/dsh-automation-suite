# AGENTS.md — dsh-automation-suite

本仓库是 **DeepSeek Harness 插件发行版 Monorepo**（非官方，与 DeepSeek 无关）。
这里是仓库级约定；用户级约定见 `~/.dsh/AGENTS.md`；单个插件的项目级约定见该包自己的 `AGENTS.md`。

---

## 1. 结构与命名

```
packages/*   插件包。每个都是可安装的 DSH bundle（声明 dsh.bundle.patch）
profile/*    profile 蓝图。物化成 ~/.dsh/profiles/<name>/ 后使用
scripts/     Monorepo 级工具脚本
docs/        发行版层面的文档：vision.md（愿景与分层方案）、architecture.md（接口插件族与两个工程插件的目标架构）、
             decisions.md（已定的取舍）、open-questions.md（待决策问题，用户直接在里面填答复）、
             roadmap.md（路线图与现状）
```

`docs/` 只放**发行版层面**的说明；插件自己的文档归各包的 `docs/`。
"做到哪了"的状态只在 `docs/roadmap.md` 与根 `README.md` §2 两处维护，改一处必须同步另一处。

新增插件时直接在 `packages/` 下建目录，不需要再走迁移流程。

### 唯一开发位置与历史归档

插件的**唯一开发位置**是本仓库的 `packages/dsh-tia-openness-v17-min`。原独立仓库已归档为
`C:\Users\Ansel\dsh-plugin\TIAOpennessV17Min.archived` —— **不要再改它、不要往里提交**。

- 归档目录保留了迁移前的 **10 个提交**（分支 `feat/siemens-nuget`，HEAD `cfa1244`）与干净的
  `git status`。monorepo 里的插件是**压平导入**的（单个初始提交），插件的历史只在那里：
  `git -C C:\Users\Ansel\dsh-plugin\TIAOpennessV17Min.archived log --oneline`
- 迁移是**无损单向**的：曾逐文件比对哈希，归档目录里没有任何本仓库缺的文件（0 个）。
- 需要把历史接进本仓库属于重写历史的操作，要做单独规划，别顺手做。

### 第三方插件是 vendor 副本，包名不加 scope

`packages/dsh-tool-git` 不是本仓原创代码，而是上游
[`lxj808624/dsh-tool-git`](https://github.com/lxj808624/dsh-tool-git) `v0.1.3` 的**压平 vendor 副本**，
**包名刻意保持上游的 `dsh-tool-git`（不加 scope）**。因此：

- `package.json` 的 `name` 与 `cordis.patch.yml` 的 `insert[].name` **都**是 `dsh-tool-git`
  （不以 `@` 开头，YAML 里不需要引号）；改任一处必须同步另一处；
- 它**不能**以同名发布到 npm（`dsh-tool-git` 已被上游占用），要发布得先决定是改 scope 还是只出 tarball；
- 它的开发期约定与 TIA 包**不完全相同**（多了 `src/dsh-runtime.d.ts`、tsdown 的 `deps.neverBundle`），
  见 `packages/dsh-tool-git/AGENTS.md`，不要按 TIA 包的印象去改它。

### bundle 包名与 patch 名必须逐字一致（强制）

DSH 的解析机制有两条独立路径，**两者都靠包名**：

1. `dsh.profile.bundles` 里的名字 → 用于解析 bundle 目录（`resolveBundleDir`）；
2. bundle 的 `cordis.patch.yml` 里 `insert[].name` → 被当作**模块标识符**交给 cordis Loader import。

因此一旦给包加 scope，`cordis.patch.yml` 里的 `insert[].name` **必须同步改成带 scope 的完整包名**，
否则插件在加载期报模块解析失败。官方 bundle 也是这么写的
（例：`@deepseek-ai/dsh-experimental-schedule-bundle`）。

另外：YAML 里以 `@` 开头的 scalar **必须加引号**，`@` 在 YAML 中是保留起始字符。

```yaml
- insert:
    - id: my-plugin
      name: '@scope/my-plugin'   # ← 引号必须有，且等于 package.json 的 name
```

### 系统提示词注入在 profile 蓝图里（发行版政策层）

模型看到的**发行版规矩**注入在 profile 蓝图里，**不在任何插件里**——改它不需要写代码、也不需要重新构建：

| 位置 | 是什么 |
|---|---|
| `profile/dsh-automation-suite/cordis.patch.yml` | 政策层本体：`- id: system-prompt`（全局 persona）、`- id: agent-preset-registry`（默认 preset）、`- insert: - id: preset-suite`（发行版 preset，政策文本就在它的 persona 行里） |
| 同上文件头部注释 | 为什么必须整份重述 preset、升级 DSH 后怎么重新生成 |
| `profile/dsh-automation-suite/README.md` | 「发行版政策层」一节：机理、验收、演示命令 |
| 根 `README.md` §8.1 / §11 | 用户向说明与验收行数 |

**要改政策文字，只改 `personaPrefix` / `personaSuffix` 两处 block scalar。**

三条会**静默出错**的注意事项（都已实测，别凭直觉改）：

1. **别"简化"成只留 `- id: system-prompt` 一行**。web 组合的 agent 一律走 preset，preset 里的
   `dsh-persona` 按作用域**遮蔽**全局 persona —— 实测：给全局 persona 打标记，该标记不会出现在
   preset 会话的提示词里。全局那一行只对非 preset 的 agent 有效。
2. **别只往 preset 里写一个 persona 行**。loader 的 patch 是「按 key 浅合并、`config` 整体替换」
   （`cordis-plugin-loader` 的 `Entry.update`），嵌套 `config.plugins` **不按 id 合并**；而 web 组合里
   `dsh-base` 的全局工具行全是 `disabled: true`，真正生效的工具面就在 preset 的 `plugins` 里 ——
   漏掉整份清单会让该 agent 的工具**静默消失**，不报错。所以 `preset-suite` 必须整份照抄 `standard`。
3. **改完蓝图不等于生效**。`scripts/start-env.ps1` 只在 profile 目录**尚不存在**时拷贝
   `cordis.patch.yml`，已物化的 profile 要 `-Reset` 或手动同步；而物化目录里那份是**应用会回写的
   活状态**（设置项以行形式写回，CST 保留式写入），同步时**追加/合并**，不要整文件覆盖。

验证政策是否真的进了提示词，不必猜：会话日志（`<DSH_HOME>/sessions/**/session.v4.jsonl.zstd`，
多帧 zstd）里有真实的 `system/message` 事件，可直接读渲染后的全文。

---

## 2. 常规命令

```powershell
pnpm install              # 全仓安装
pnpm -r build             # 全仓构建
pnpm -r typecheck         # 全仓类型检查
pnpm test                 # 全仓测试
pnpm run clean:build      # 清构建产物（只碰 lib/ dist/）
```

`clean` 这个名字**不要用**：pnpm 11 有内置子命令会遮蔽脚本。已改名为 `clean:build`。

注意 pnpm 递归运行的两种失败形态，都会让根脚本"看起来在跑其实没跑"：

* 某个脚本名**没有任何成员定义**时 → `ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT`（`typecheck`
  曾经就是如此，所以给插件补了同名脚本）；
* 脚本名与 pnpm **内置子命令重名**时 → 报无关的选项错误（`clean` 就是被内置命令截走）。
  递归运行读不到某个成员的同名脚本则只跳过、不报错，所以 `pnpm -r test` 可用。

---

## 3. 危险操作红线

以下每一条都有真实事故记录（见 `packages/dsh-tia-openness-v17-min/docs/ECOSYSTEM-COMPAT.md`）：

- ❌ **禁止**用 `rm -rf`、.NET `Directory.Delete` 等**会跟进 junction/symlink 目标**的递归删除去清 `node_modules`。
  该文档记录的事故里，这类删除毁掉了源仓库的 `.git` 元数据。
- ❌ **禁止**在根 `package.json` 里把 `@deepseek-ai/*`（或任何 DSH 运行时包）声明为依赖。
  插件运行期从 profile 的运行时解析拿到它们，根包永远不该有。
- ❌ **禁止**把根 `package.json` 的 `private` 去掉。
- ✅ 拆 junction 只用 `cmd /c rmdir "<路径>"`（只删链接本身），或 `Remove-Item -Force`（不加 `-Recurse`）。
- ✅ 要清构建产物，用 `pnpm run clean:build`：它只检查 `lib/`、`dist/`，且遇链接只 unlink、不下降。
- ✅ `pnpm run link:runtime -- --force` 也是安全的：目标若是 junction/symlink 只 `unlink`，绝不递归下降。

自 D19 起，插件的 `node_modules/@deepseek-ai/*` 链接指向 `<DSH_HOME>/plugin-runtime`
（本仓库流程自己创建、只含真实目录的抽取缓存），**不再指向 DSH 安装目录里的包**，
所以这类删除已经无法经由这些链接传导到 DSH 自身。链接指向安装目录的写法是历史形态，
不要退回。

---

## 4. 测试与验收

```powershell
pnpm test          # 全仓：TIA 77 项（76 通过 / 1 跳过）+ dsh-tool-git 33 项 + engineering-context 35 项 + engineering-graph 46 项
pnpm -r build
pnpm -r typecheck
```

四个插件用**两种测试运行器**，`pnpm -r test` 会把四者都跑到：

| 包 | 运行器 | 命令 |
|---|---|---|
| `dsh-tia-openness-v17-min` | `node:test` | `node --test test/*.test.mjs` |
| `dsh-tool-git` | `vitest` | `vitest run` |
| `dsh-engineering-context` | `node:test` | `node scripts/run-tests.mjs`（**先构建再跑**，因为它不提交 `lib/`） |
| `dsh-engineering-graph` | `node:test` | `node scripts/run-tests.mjs`（**先构建再跑**，同上） |

⚠️ `dsh-engineering-graph` 还有一个 **C# 引擎**（`engine/`，net8）。`pnpm -r build` 只构建 TypeScript ——
引擎要用 `pwsh -NoProfile -File engine/build.ps1` 构建到 `engine/bin/`（**不进 git**，与接口插件族的控制器同理）。
它有一项测试**驱动该引擎**（跑 `--self-test`：原生 SQLite 加载 + 真实导出物解析 + 只读闸门），
引擎没构建时那条测试会 **skip 并打印构建命令**，而不是失败 —— 所以"全绿"不等于"引擎也验过了"。

单测都需要**真实的** `@deepseek-ai/*` 运行时（不是 stub）。裸 checkout 首次运行时，
各包的测试自举会各自自动触发抽取；也可以手动：

```powershell
pnpm --filter @voltarenyah/dsh-tia-openness-v17-min run link:runtime
pnpm --filter dsh-tool-git run link:runtime
pnpm --filter @voltarenyah/dsh-engineering-context run link:runtime
pnpm --filter @voltarenyah/dsh-engineering-graph run link:runtime
```

前两者从**已安装 app 自己的 `resources/app.asar`** 里求闭包（约 32 个包 / 8 MB / <1 s），
解包到 `<DSH_HOME>/plugin-runtime`，再 junction 到各自包的 `node_modules/@deepseek-ai/`。
`runtime.json` 记下宿主版本，宿主升级后自动重抽。环境变量覆盖：`DSH_APP_ASAR`（asar 路径）、
`DSH_HOME`（harness home）。

⚠️ `dsh-engineering-context` 与 `dsh-engineering-graph` 的链接脚本只链 `@deepseek-ai/*`，且**从不抽取**：
它们只读已存在的 `<DSH_HOME>/plugin-runtime`，缺包就报错并让你去跑兄弟包的抽取器。理由：抽取会删除并重建
一个**在仓库之外、无法用 git 恢复**的目录。它们的依赖（`typescript` / `@types/node`）由
`pnpm install` 提供 —— **手工链接绝不能指向另一个 workspace 包的 `node_modules`**，
否则 pnpm 的链接阶段会以 ENOENT 失败（实测事故见该包 `docs/decisions.md` P0-14）。

**抽取出来的运行时不含 `.d.ts`**（app 的生产构建剥掉了类型声明），所以各包各自手写了一份
环境声明来喂 `tsc`：`packages/*/src/dsh-runtime.d.ts`。抽取的 `RUNTIME_ROOTS` 与手写声明
**都按包而异**（`dsh-tool-git` 多一个 `dsh-system-prompt`，且需要 `oneOf` 的特殊处理），
改一个包时别照抄另一个包。

**版本必须对齐运行中的宿主**：手动把来源指回 `~/.dsh/profiles/*/node_modules` 会验到旧版本
（那里是 0.1.5-rc.2，宿主是 0.2.0-rc.2），等于用错版本验收。见 `docs/decisions.md` D19。
这条不是理论风险：那份投影安装里的 `@deepseek-ai/dsh-tools` 实际是一个指向 `npm-cache/_npx`
的**悬空 junction**，读不到任何东西。

profile 组合的端到端验收：

```powershell
dsh --profile dsh-automation-suite --dump-config
```

预期结尾出现（每个本地插件 3 行；基线 **1268 行** = 官方 web 组合 1259 + 3 × 3，
**加上 §1「系统提示词注入在 profile 蓝图里」那条政策层后 +252 行** —— 本机实测
`dsh --profile web --patch profile/dsh-automation-suite/cordis.patch.yml --dump-config`
是 1268 → 1520）：

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

> 注意：工程知识图谱插件（`@voltarenyah/dsh-engineering-graph`）**刻意还没登记进蓝图**，所以下面的
> 预期输出里**没有它**，行数也不含它；它一登记，每个本地插件就是 4 × 3 行。

装 tarball 的验收链路：

```powershell
cd packages/<pkg>; pnpm pack
dsh plugin --profile <临时 profile> add <tarball>
dsh --profile <临时 profile> --dump-config     # 含你的插件行 = 通过了
```

强于 `--dump-config` 的一条：`dsh --profile <p> --dump-config-schema`，若输出里出现该插件的
Config 字段（如 `opennessDir`，或 git 插件的 `destructivePolicy`），说明模块被**真实 import
并读取了 schema**。注意该命令本身在未装任何插件的 `web` profile 上也返回 exit 1 —— 那 4 条
`unrecognized Loader tree carrier` 错误落在官方 `dsh-agent-preset` 的 4 个行上（`/179`–`/182`），
与插件无关，**不要**把它当成插件问题去查。

---

## 5. 其它踩过的坑

- `pnpm pack` 对 `@scope/name` 产出的文件名是 `scope-name-<version>.tgz`（剥掉 `@`、`/`→`-`），
  **不要**在脚本里硬编码 `@scope-` 前缀。不带 scope 的包就是 `<name>-<version>.tgz`。
- **本机同时存在两个 pnpm 身份，别把它们搞混**：
  - 随 DSH 分发的 `resources/runtime/pnpm/bin/pnpm.mjs` 本身是 **11.7.0**，但根 `package.json`
    声明了 `packageManager: pnpm@9.12.0`，所以**在仓库根跑它时会自动切到 9.12.0** ——
    锁文件是 `lockfileVersion: '9.0'`，`node_modules/.modules.yaml` 里写着 `packageManager: pnpm@9.12.0`。
    因此 pnpm 10/11 专有的配置键（`allowBuilds`、`minimumReleaseAge`、`onlyBuiltDependencies` 的
    新位置）在本仓**不生效**，不要照搬 pnpm 11 的写法。
  - 物化出来的 profile 目录里**没有** `packageManager` 字段，所以 `dsh plugin --profile <p> install`
    跑的是那个 **11.7.0**（实测输出 `Done in … using pnpm v11.7.0`）。
- **在 JS 块注释里写 glob 会截断注释**：`profiles/*/node_modules` 里的 `*/` 会提前结束
  `/** … */`，剩下半句被当成代码，报出与真实位置无关的语法错误。写路径用
  `profiles/<profile>/node_modules`，或转义成 `*\/`。
- 从 `cmd.exe` / `Start-Process` 调 `dsh.cmd` 时，安装路径里的空格会被 cmd 剥掉引号
  （`'…\DeepSeek' is not recognized`）。用 PowerShell 的调用运算符 `& $dsh`。
- **`tsdown` 会把能解析到的包打进产物**。插件对 `@deepseek-ai/*` 的 import 必须在构建期保持外部，
  否则产物里会塞进一份私有的宿主运行时。`dsh-tool-git` 用 `deps: { neverBundle: true }` 钉住这一点；
  详细机理与验收口径见 `packages/dsh-tool-git/AGENTS.md`。新增插件时同样要显式声明。

---

## 6. 本地验收环境（独立 DSH_HOME，一条命令）

把"按蓝图物化 profile + 装插件 + 起服务 + 带 token 开浏览器"收成一条命令：

```powershell
pwsh -NoProfile -File scripts\start-env.ps1
```

- 默认 `DSH_HOME=%USERPROFILE%\dsh-suite-env`，**不碰日常 `~/.dsh`**；删掉该目录即完全回退。
- 默认 `-Mode link`：把**蓝图里指到 `packages/` 的每个本地插件**以 `link:` 链进 profile，验的是
  **当前工作树**（每次启动会先 `pnpm -r build`，所以改完 `src/` 直接重启即可）；
  `-Mode pack` 改为逐个 `pnpm pack` 出 tarball 再装，验**真实交付物**。
- **要部署哪些插件不写死在脚本里**：`Get-LocalPlugins` 读蓝图 `dsh.profile.bundles`，凡是能在
  `packages/` 下按 `package.json` 的 `name` 匹配到的条目都算本地插件（带 scope 与不带 scope 同一套逻辑）。
  所以新增插件只要建目录 + 把包名写进蓝图 bundles，本脚本无需改动。
- 本机 `pnpm` 与 `dsh` **都不在 PATH 上**（`node` 在），脚本自己从 DSH 安装目录解析它们；
  可用 `$env:DSH_APP_ROOT` 覆盖安装目录。
- 其它开关：`-DshHome`、`-Port`（默认 3092，`0` 为随机）、`-Restart`、`-NoOpen`、`-Reset`、`-SkipBuild`。
- 启动后 `dsh` 会打印带 token 的 URL；**不加 `--no-open` 时它会自动用默认浏览器打开**。
  token 每次启动都换、不落盘，裸地址会 401。
- 首次进入要由使用者自己配模型：**设置 → Models 填 API key**（或首次运行弹窗
  "Add an API key to get started"）。凭据落在该 home 的 `.credentials.yaml`，与日常 home 无关。
- 验收 TIA 工具前先把 `requestTimeoutMs` 调大：默认 300000（5 分钟），而实测导出 237 块要 87 s、
  编译大项目文档记的是"常需 10 分钟以上"。在 profile 的 `cordis.patch.yml` 里覆盖即可。
- ⚠️ 用 `-Reset` 或手删该 home 时，**必须**用 `cmd /c rmdir /s /q`：里面 `link:` 与 pnpm 的
  junction 指向仓库和 pnpm store，跟进式递归删除会毁掉目标（见第 3 节）。

### 触发约定

使用者说「**启动 App**」（或同义的一句话，例如"起一下环境"）时，就是要在仓库根执行：

```powershell
pwsh -NoProfile -File scripts\start-env.ps1 -Restart
```

`-Restart` 让这条命令**永远可用**：端口上已有实例就先停掉它再起，所以"改完代码 → 启动 App"
是一步，不需要手工先停。它只停 `DeepSeek Harness` —— 占用者不是它就报错退出，不会误杀别的进程。

跑完把 DSH 打印的带 token URL 报给他（URL 会出现在那个新开的控制台窗口里，浏览器也会自动打开）。
想换个端口就加 `-Port`。

**故意不加 `-Restart`** 时，端口被占用会直接报错并指出占用进程 —— 这是"我只想确认它是不是已经在跑"
的用法，用来避免无意中重启掉正在用的实例：

```powershell
Get-NetTCPConnection -State Listen -LocalPort 3092 -ErrorAction SilentlyContinue |
  ForEach-Object { Get-Process -Id $_.OwningProcess }
```

### 怎么判断启动成功

1. 控制台出现 `dsh web: http://127.0.0.1:<port>/?token=…`，且浏览器自动打开；
2. 该端口有监听（上面那条命令能查到 `DeepSeek Harness`）；
3. **插件真的加载了**的硬证据：出现 `TiaOpennessV17Min.Controller` 子进程
   （`Get-Process TiaOpennessV17Min.Controller`）—— 说明 `apply()` 执行过、`ctx.effect`
   持有子进程。没看到它，就是插件没加载，别急着怀疑 TIA。

### 怎么停

在该实例的窗口里 `Ctrl+C`。窗口已丢时：`Stop-Process -Id <harness pid> -Force`，
控制器会随后读到 stdin EOF 自行退出；用 `Get-Process TiaOpennessV17Min.Controller`
确认已无残留。**不要**用会跟进链接的递归删除去清那个 home（见第 3 节）。
