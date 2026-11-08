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
site/        产品介绍页（GitHub Pages 发布物，纯静态；pages.yml 只上传这一目录）
tools/       仓库级本地工具，不进发布物：site-editor = 站点文案可视化编辑（见 §10）
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
| `profile/dsh-automation-suite/cordis.patch.yml` | 政策层本体：`- id: system-prompt`（全局 persona）、`- id: agent-preset-registry`（默认 preset = `leader`）、`- insert: - id: preset-leader`（主 agent preset，政策文本在它的 persona 行里）、`- insert: - id: preset-auditor`（版本管理 preset；`subagent.allowedAgentPresets` 含它，所以 leader 能派它跑慢活）、`- insert: - id: preset-expert`（子 agent preset）、`- id: engineering-context`（`disabled: true`；三个入口分开挂：`.`→`auditor`、`/diff`→`auditor`+`expert`、`/status`→`leader`，见 D30） |
| 同上文件头部注释 | 为什么必须整份重述 preset、工具面为什么按 preset 分发、升级 DSH 后怎么重新生成 |
| `profile/dsh-automation-suite/README.md` | 「发行版政策层」「三个 preset：`leader`、`auditor` 与 `expert`」两节：机理、验收、演示命令 |
| 根 `README.md` §8.1 / §11 | 用户向说明与验收行数 |

**要改政策文字，只改四处 block scalar**（全局 `personaPrefix`/`personaSuffix`、`preset-leader`
的 persona、`preset-auditor` 的 persona、`preset-expert` 的 persona）。

四条会**静默出错**的注意事项（都已实测，别凭直觉改）：

1. **别"简化"成只留 `- id: system-prompt` 一行**。web 组合的 agent 一律走 preset，preset 里的
   `dsh-persona` 按作用域**遮蔽**全局 persona —— 实测：给全局 persona 打标记，该标记不会出现在
   preset 会话的提示词里。全局那一行只对非 preset 的 agent 有效。
2. **别只往 preset 里写一个 persona 行**。loader 的 patch 是「按 key 浅合并、`config` 整体替换」
   （`cordis-plugin-loader` 的 `Entry.update`），嵌套 `config.plugins` **不按 id 合并**；而 web 组合里
   `dsh-base` 的全局工具行全是 `disabled: true`，真正生效的工具面就在 preset 的 `plugins` 里 ——
   漏掉整份清单会让该 agent 的工具**静默消失**，不报错。所以 `preset-leader` 必须整份照抄 `standard`。
3. **宿主面注册的工具会被每个 agent 继承，包括子 agent**。工具可见性 = 全局层 + 作用域链上的祖先层
   逐层过 `admits`（`dsh-tools` 的 `view()`）；preset 里"不写"**不等于**隐藏。所以想让某个工具只归
   某一层 agent，只能把它拆成独立的 `/tools` 行、由 preset 声明 —— 这正是 D23 做的事。
   宿主面**只放资源与服务**（子进程、`engineeringAccess`、`knowledgeGraph`）。
4. **改完蓝图不等于生效**。`scripts/start-env.ps1` 只在 profile 目录**尚不存在**时拷贝
   `cordis.patch.yml`，已物化的 profile 要 `-Reset` 或手动同步；而物化目录里那份是**应用会回写的
   活状态**（设置项以行形式写回，CST 保留式写入），同步时**追加/合并**，不要整文件覆盖。
5. **persona 里的 `{{...}}` 是严格插值，可用的只有 `provider` 与 `model`**（`dsh-agent-loop`
   注册的，`dsh-system-prompt` 的 `interpolate()` 遇到未注册名字会抛错）。写 `{{cwd}}` 这类
   想象出来的变量，症状不是日志警告而是**用户发第一句话时整轮失败**：
   `unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix"; registered variables: provider, model`。
   这条既适用于 preset 的 `dsh-persona` 行，也适用于全局 `system-prompt` 行 —— 两处都会炸。
   工作目录/模型名本来就在 runtime context 里，persona 不必再插值一遍。

验证政策是否真的进了提示词，不必猜：会话日志（`<DSH_HOME>/sessions/**/session.v4.jsonl.zstd`，
多帧 zstd；解压命令与"按 sessionID 找会话"见 §6「3095 测试会话在哪」）里有真实的 `system/message`
事件，可直接读渲染后的全文。

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
pnpm test          # 全仓：TIA 112 项（111 通过 / 1 跳过）+ dsh-tool-git 51 项 + engineering-context 151 项 + engineering-graph 128 项 + drawing 23 项 + plcsim-advanced 10 项 + ui-plc-source 47 项 + ui-tia-console 22 项 + ui-versions 15 项 + ui-hardware 9 项 + ui-prompt-guide 25 项 + ui-brandmark 5 项 + tia-todo-bridge 18 项
pnpm -r build
pnpm -r typecheck
```

本地插件加 vendor 的 `dsh-tool-git` 用**两种测试运行器**，`pnpm -r test` 会把它们都跑到：

| 包 | 运行器 | 命令 |
|---|---|---|
| `dsh-tia-openness-v17-min` | `node:test` | `node --test test/*.test.mjs` |
| `dsh-tool-git` | `vitest` | `vitest run` |
| `dsh-engineering-context` | `node:test` | `node scripts/run-tests.mjs`（**先构建再跑**，因为它不提交 `lib/`） |
| `dsh-engineering-graph` | `node:test` | `node scripts/run-tests.mjs`（**先构建再跑**，同上） |
| `dsh-drawing` | `node:test` | `node scripts/run-tests.mjs`（**先构建再跑**；PDF 索引/检索模型 + 字典，浏览器半侧靠真实图纸验收） |
| `dsh-plcsim-advanced` | `node:test` | `node --test --test-reporter=spec "test/*.test.mjs"`（纯协议与工具面，控制器不在时降级） |
| `dsh-ui-plc-source` | `node:test` | `node scripts/run-tests.mjs`（**先构建再跑**，同上；浏览器半侧是 `.jsx`，不进 `tsc`，靠这套纯模型单测 + 浏览器验收） |
| `dsh-ui-tia-console` | `node:test` | `node scripts/run-tests.mjs`（**先构建再跑**；纯事件折叠 + 字典，浏览器半侧靠真实 `/tia-*` 流程验收） |
| `dsh-ui-versions` | `node:test` | `node scripts/run-tests.mjs`（**先构建再跑**；纯视图解析/筛选/时间线 + 字典，浏览器半侧靠真实 `.dsh/versions-view.json` 验收） |
| `dsh-ui-hardware` | `node:test` | `node scripts/run-tests.mjs`（**先构建再跑**；视图解析/筛选/机位面 + 字典，浏览器半侧靠真实 `.dsh/hardware-view.json` 验收） |
| `dsh-ui-prompt-guide` | `node:test` | `node scripts/run-tests.mjs`（**先构建再跑**；内容数据完整性 + 工具白名单、路径安全/trust fence/路由响应、产物包装与 seat 名；浏览器半侧靠真实 dev-env 验收） |
| `dsh-ui-brandmark` | `node:test` | `node scripts/run-tests.mjs`（**先构建再跑**；文案映射/字典落回 + 128px 桌面图标 + manifest 与 Loader 行一致性，5 项；浏览器半侧靠真实 dev-env 验收） |
| `dsh-ui-changes` | `node:test` | `node scripts/run-tests.mjs`（**先构建再跑**；Changes 面板 P1：git 状态路由/服务/字典 + 客户端折叠，48 项） |
| `dsh-tia-todo-bridge` | `node:test` | `node --test --test-reporter=spec "test/*.test.mjs"`（纯状态机 + manifest，18 项；不依赖 TIA） |

⚠️ `dsh-engineering-graph` 还有一个 **C# 引擎**（`engine/`，net10，需要 .NET 10 SDK）。`pnpm -r build` 只构建 TypeScript ——
它的产物 `engine/bin/` **进 git**（与接口插件族的 `controller/bin` 同理），所以 checkout 开箱可用；只有改了 C# 源码才需要 `pwsh -NoProfile -File engine/build.ps1` 重建（输出到 `engine/bin/`，其中 `engine/bin/fixtures/` 与 `engine/obj/` 被 ignore）。
**发布包里的引擎是 self-contained win-x64 单文件**：`scripts/build-distribution.mjs` 在打包时用 .NET 10 SDK 生成到临时 staging，用户不需要安装 .NET；仓库里的 `engine/bin/` 仍是 framework-dependent 的开发/测试构建（跑测试要有 .NET 10 runtime，或设 `DOTNET_ROOT`）。
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
（那里是 0.1.5-rc.2，而宿主已是 0.2.1-rc.2），等于用错版本验收。见 `docs/decisions.md` D19。
这条不是理论风险：那份投影安装里的 `@deepseek-ai/dsh-tools` 实际是一个指向 `npm-cache/_npx`
的**悬空 junction**，读不到任何东西。

profile 组合的端到端验收：

```powershell
dsh --profile dsh-automation-suite --dump-config
```

预期结尾出现 **16 个插件行**（15 个本地插件 + 公共的 `dsh-opencode-go`），顺序与蓝图的
`dsh.profile.bundles` 一致；其中 `engineering-context` 带 `disabled: true`（它整行搬进了 `leader` preset）：

```yaml
# == @voltarenyah/dsh-tia-openness-v17-min
- id: tia-openness-v17-min
  name: '@voltarenyah/dsh-tia-openness-v17-min'
# == @voltarenyah/dsh-plcsim-advanced
- id: plcsim-advanced
  name: '@voltarenyah/dsh-plcsim-advanced'
# == @voltarenyah/dsh-engineering-context, patched by …\cordis.patch.yml
- id: engineering-context
  name: '@voltarenyah/dsh-engineering-context'
  disabled: true
# == @voltarenyah/dsh-engineering-graph
- id: engineering-graph
  name: '@voltarenyah/dsh-engineering-graph'
# == @voltarenyah/dsh-drawing
- id: drawing
  name: '@voltarenyah/dsh-drawing'
# == dsh-tool-git
- id: tool-git
  name: dsh-tool-git
# == dsh-ui-plc-source
- id: ui-plc-source
  name: dsh-ui-plc-source
# == dsh-ui-tia-console
- id: ui-tia-console
  name: dsh-ui-tia-console
# == dsh-ui-versions
- id: ui-versions
  name: dsh-ui-versions
# == dsh-ui-changes
- id: ui-changes
  name: dsh-ui-changes
# == dsh-ui-hardware
- id: ui-hardware
  name: dsh-ui-hardware
# == dsh-ui-prompt-guide
- id: ui-prompt-guide
  name: dsh-ui-prompt-guide
# == dsh-ui-project-dashboard
- id: project-dashboard
  name: dsh-ui-project-dashboard
# == dsh-ui-brandmark
- id: ui-brandmark
  name: dsh-ui-brandmark
# == @voltarenyah/dsh-tia-todo-bridge
- id: tia-todo-bridge
  name: '@voltarenyah/dsh-tia-todo-bridge'
# == dsh-opencode-go
- id: opencode-go
  name: dsh-opencode-go
```

行数基线（**DSH 0.2.1-rc.2 实测，2026-11-08（加入 `dsh-ui-changes`、`dsh-ui-project-dashboard`、
`dsh-tia-todo-bridge`、`dsh-ui-brandmark` 与目录选择器 pin 之后）**；换宿主版本、改蓝图或增减插件后必须重测）：

| 命令 | 行数 |
|---|---|
| `dsh --profile web --dump-config`（官方组合，全新 `DSH_HOME`） | **1229** |
| `dsh --profile web --patch profile/dsh-automation-suite/cordis.patch.yml --dump-config`（全新 `DSH_HOME`） | **2098** |
| 按蓝图物化的 profile（link 模式，当前工作树）：`dsh --profile dsh-automation-suite --dump-config` | **2162**（2026-11-08 在全新临时 `DSH_HOME` 里实测，16 个插件行；比政策层多出的行来自物化目录里应用回写的设置行 —— `ui-settings-general` 与调大过的 `requestTimeoutMs`） |

> ⚠️ 上一版基线 **1183 / 2099 / 2155**（2026-11-08 早些时候，同日重测已不重现）作废：同一条命令、同一宿主
> 版本，2026-11-08 晚上重测得到 **1229 / 2098 / 2162**（前两条在**全新** `DSH_HOME` 里跑；日常 `~/.dsh` 里
> 同样的前两条各多 6 行 = 1235 / 2104，那 6 行来自应用回写/装过的 bundle）。更早的 1235 / 2003 / 2036
> （2026-10-20）同样作废。别拿新旧数值互相解释，用**同一次**跑出来的三个数一起看。行数只用来发现
> 「整行消失」这类事故，别把它当精确断言。**要证明插件真的被 import 过，用下面的 `--dump-config-schema`。**

装 tarball 的验收链路：

```powershell
cd packages/<pkg>; pnpm pack
dsh plugin --profile <临时 profile> add <tarball>
dsh --profile <临时 profile> --dump-config     # 含你的插件行 = 通过了
```

强于 `--dump-config` 的一条：`dsh --profile <p> --dump-config-schema`，若输出里出现该插件的
Config 字段（如 `opennessDir`，或 git 插件的 `destructivePolicy`），说明模块被**真实 import
并读取了 schema**。注意该命令本身在未装任何插件的 `web` profile 上也返回 exit 1 —— 那几条
`unrecognized Loader tree carrier` 错误落在 `dsh-agent-preset` 行上，**每个 preset 行两条**
（行本身 + 它内部的 `cordis:group`）：官方 `web` 实测 **8 条**，本套件 profile 实测 **14 条**
（多出 6 条 = 本蓝图插入的 `preset-leader` / `preset-auditor` / `preset-expert`），与插件无关，
**不要**把它当成插件问题去查。D30 增加 `preset-auditor` 前后都是 14 条（改动前后各测过一次）。

---

## 5. 其它踩过的坑

- `pnpm pack` 对 `@scope/name` 产出的文件名是 `scope-name-<version>.tgz`（剥掉 `@`、`/`→`-`），
  **不要**在脚本里硬编码 `@scope-` 前缀。不带 scope 的包就是 `<name>-<version>.tgz`。
- **本机同时存在两个 pnpm 身份，别把它们搞混**：
  - 随 DSH 分发的那份在 `resources/runtime/primary-runtime/dependencies/pnpm/`（0.2.0-rc.2 时是
    `resources/runtime/pnpm/` —— 升级会挪位置，脚本里要按候选列表探测）。它本身是 **11.28.5**，
    但根 `package.json` 声明了 `packageManager: pnpm@9.12.0`，所以**在仓库根跑它时会自动切到
    9.12.0** —— 锁文件是 `lockfileVersion: '9.0'`，`node_modules/.modules.yaml` 里写着
    `packageManager: pnpm@9.12.0`。因此 pnpm 10/11 专有的配置键（`allowBuilds`、
    `minimumReleaseAge`、`onlyBuiltDependencies` 的新位置）在本仓**不生效**，不要照搬 pnpm 11 的写法。
  - 物化出来的 profile 目录里**没有** `packageManager` 字段，所以 `dsh plugin --profile <p> install`
    跑的是自带的那份全集（0.2.1-rc.2 实测输出 `Done in … using pnpm v11.28.5`）。
  - **本机 `pnpm` 不在 PATH 上**，所以根脚本 `pnpm test`（= `pnpm -r test`）会以
    `'pnpm' is not recognized` 失败。要么把自带 pnpm 的目录加进 PATH，要么做一个指向
    `…/pnpm/bin/pnpm.mjs` 的 `pnpm.cmd` shim；也可以按包单独跑各自的 `test`。
- **DSH 自带的那份 node 不是一个 `node.exe`**：0.2.1-rc.2 的 `resources/runtime/bin/` 下只有
  `node`（sh 脚本）与 `node.cmd`，后者转发到 `%DSH_DESKTOP_NODE_EXECUTABLE%` —— 该变量由桌面应用
  传给子进程，普通 shell 里通常没有。所以脚本里的 node 探测顺序应是
  `$env:DSH_DESKTOP_NODE_EXECUTABLE` → 旧布局的 `runtime\bin\node.exe` → PATH。
- **在 JS 块注释里写 glob 会截断注释**：`profiles/*/node_modules` 里的 `*/` 会提前结束
  `/** … */`，剩下半句被当成代码，报出与真实位置无关的语法错误。写路径用
  `profiles/<profile>/node_modules`，或转义成 `*\/`。
- 从 `cmd.exe` / `Start-Process` 调 `dsh.cmd` 时，安装路径里的空格会被 cmd 剥掉引号
  （`'…\DeepSeek' is not recognized`）。用 PowerShell 的调用运算符 `& $dsh`。
- **在 profile 里装带构建脚本的公共插件会被 pnpm 11 拒一次**：`dsh plugin --profile <p> install`
  跑的是自带 pnpm 11.28.5，只要依赖树里有未声明决定的构建脚本就整体退出 1
  （`ERR_PNPM_IGNORED_BUILDS`，包其实已经装上了）。实测触发者：`dsh-opencode-go` 的传递依赖
  `@google/genai`、`protobufjs`。解法是在该 profile 的 `pnpm-workspace.yaml` 里写
  `allowBuilds: { '<包>': false }`（本蓝图已写；桌面 profile 也是这么做的）。
  注意这条只在 **profile** 里成立 —— 仓库根跑的是 pnpm 9.12，这个键无效（见下条）。
- **`profile/*` 是 pnpm workspace 成员，给蓝图加公共依赖会进根 lockfile**：根 `.npmrc` 写了
  `auto-install-peers=false`，因为 pnpm 9 默认会给新依赖自动装一套 `@deepseek-ai/* 0.1.5-rc.3`
  到 node_modules 与 `pnpm-lock.yaml` —— 那正是 D19 的「验到旧宿主版本」陷阱，还会在解析时
  抢在宿主运行时前面。改完蓝图的依赖后跑一次
  `pnpm install --lockfile-only`（本机 `pnpm` 不在 PATH，用自带那份）并确认 diff 里**没有**
  `+  '@deepseek-ai/dsh-llm@…` 这类运行时包的整棵子树；`--frozen-lockfile --lockfile-only` 应 exit 0。
- **`tsdown` 会把能解析到的包打进产物**。插件对 `@deepseek-ai/*` 的 import 必须在构建期保持外部，
  否则产物里会塞进一份私有的宿主运行时。`dsh-tool-git` 用 `deps: { neverBundle: true }` 钉住这一点；
  详细机理与验收口径见 `packages/dsh-tool-git/AGENTS.md`。新增插件时同样要显式声明。

---

## 6. 本地验收环境（独立 DSH_HOME，一条命令）

把"按蓝图物化 profile + 装插件 + 起服务 + 带 token 开浏览器"收成一条命令：

```powershell
pwsh -NoProfile -File scripts\start-env.ps1
```

- 默认 `DSH_HOME=%USERPROFILE%\dsh-automation-suite-home`（**当前维护的那套**），**不碰日常 `~/.dsh`**；
  删掉该目录即完全回退。旧的 `%USERPROFILE%\dsh-suite-env`（3092）已于 2026-11-04 删除，别再起它。
- 默认 `-Mode link`：把**蓝图里指到 `packages/` 的每个本地插件**以 `link:` 链进 profile，验的是
  **当前工作树**（每次启动会先 `pnpm -r build`，所以改完 `src/` 直接重启即可）；
  `-Mode pack` 改为逐个 `pnpm pack` 出 tarball 再装，验**真实交付物**。
- **要部署哪些插件不写死在脚本里**：`Get-LocalPlugins` 读蓝图 `dsh.profile.bundles`，凡是能在
  `packages/` 下按 `package.json` 的 `name` 匹配到的条目都算本地插件（带 scope 与不带 scope 同一套逻辑）。
  所以新增插件只要建目录 + 把包名写进蓝图 bundles，本脚本无需改动。
- 本机 `pnpm` 与 `dsh` **都不在 PATH 上**（`node` 在），脚本自己从 DSH 安装目录解析它们；
  可用 `$env:DSH_APP_ROOT` 覆盖安装目录。
- 其它开关：`-DshHome`、`-Port`（默认 3095，`0` 为随机）、`-Restart`、`-NoOpen`、`-Reset`、`-SkipBuild`。
- 启动后 `dsh` 会打印带 token 的 URL；**不加 `--no-open` 时它会自动用默认浏览器打开**。
  token 每次启动都换、不落盘，裸地址会 401。
- 首次进入要由使用者自己配模型：**设置 → Models 填 API key**（或首次运行弹窗
  "Add an API key to get started"）。凭据落在该 home 的 `.credentials.yaml`，与日常 home 无关。
- 验收 TIA 工具前先把 `requestTimeoutMs` 调大：默认 300000（5 分钟），而实测导出 237 块要 87 s、
  编译大项目文档记的是"常需 10 分钟以上"。在 profile 的 `cordis.patch.yml` 里覆盖即可。
  工程知识图谱插件**也有同名配置**（默认也是 300000），它管的是**单台设备建库**的截止时间：
  实测 1376 个源文件约 30 s、库约 450 MB —— 所以大项目要么留够 300 s，要么把这一项一起调大；
  这一步现在由 `create_engineering_project` 自动触发（见 §7）。
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
Get-NetTCPConnection -State Listen -LocalPort 3095 -ErrorAction SilentlyContinue |
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

### 3095 测试会话在哪、怎么按 sessionID 找

使用者给的 sessionID 来自哪套 home，决定了它在磁盘上的位置。**测试（3095）的会话只在
`%USERPROFILE%\dsh-automation-suite-home` 里** —— 不在日常 `~/.dsh`，也不在已删除的
`%USERPROFILE%\dsh-suite-env`（2026-11-04 删）。在 `~/.dsh` 里搜不到就断言"没有这个会话"，
是 2026-11-03 的真实误判，别再犯。

- **会话目录按工作区 cwd 编码**：`<home>\sessions\--<cwd 编码>--\`，编码规则是去掉盘符的冒号、
  把 `\` 与 `:` 都换成 `-`。测试工作区通常是 `C:\Users\Ansel\Documents\dsh-automation-suite\<项目>`，
  所以目录形如 `--C-Users-Ansel-Documents-dsh-automation-suite-<项目>--`。
- **一个会话一个子目录**：`<home>\sessions\<编码 cwd>\<sessionID>\session.v4.jsonl.zstd`，
  `sessionID` 就是会话 id 全文（形如 `session-3a96b402-…`）。子 agent 的会话是**平级**的另一个目录
  `<child-uuid>\session.v4.jsonl.zstd`（父会话的 `projcache` 里能在 `subagentCatalog` 看到它的 id）。
- **只知道 sessionID 时先按 id 找**（不依赖 cwd 拼目录；只记得 uuid 后半段时用 `-Filter '*<uuid>*'`）：

  ```powershell
  $home_ = "$env:USERPROFILE\dsh-automation-suite-home"
  Get-ChildItem "$home_\sessions" -Recurse -Directory -Filter '<sessionID>' |
    Select-Object -ExpandProperty FullName
  ```

- **不需要解压就能核对是哪个会话**：`<home>\storages\session_projcache\sessions\<sessionID>.json`
  里有 `record.identity.cwd`、`title`、`turnOutline`（每轮 prompt/response 的开头，已截断）和
  `subagentCatalog`。它是**派生缓存**，老会话可能没有对应文件；没有就直接走下面的 jsonl 解压。路径：

  ```powershell
  $home_ = "$env:USERPROFILE\dsh-automation-suite-home"
  Get-Item "$home_\storages\session_projcache\sessions\<sessionID>.json"
  ```

- **读全文要按多帧解压**：`session.v4.jsonl.zstd` 是**多帧** zstd，Node 的
  `zlib.zstdDecompressSync` 只解第一帧（实测 96 KB 的文件只出 245 B，很容易误判成"空会话"）。
  用本机 Python 的 `zstandard`（已装 0.25.0），**必须带 `-X utf8`** —— 否则 Windows 控制台默认
  cp1252，打印中文事件会直接 `UnicodeEncodeError`：

  ```powershell
  $py = "C:\Users\Ansel\AppData\Local\Programs\Python\Python313\python.exe"
  & $py -X utf8 -c "import sys,zstandard;d=zstandard.ZstdDecompressor();print(d.stream_reader(open(sys.argv[1],'rb'),read_across_frames=True).read().decode('utf-8'))" `
    "<session.v4.jsonl.zstd 的绝对路径>"
  ```

  第一行是 `{"type":"session",...,"id":"session-…","cwd":"…"}`，拿它核对 id 与工作区；
  后面每行一个事件（`system/message`、`turn/*`、`tool/*` …）。

- 当前日常 GUI（3082）的会话在 `%USERPROFILE%\.dsh\sessions\**`；两套 home 互不可见，
  报 sessionID 时先问一句"哪个 app 里测的"最省事。

---

## 7. TIA 功能测试：统一源项目（只记路径，不复制）

TIA Portal / Openness 的功能测试统一拿下面这个源项目当"源"，**不要**拿正式工程或空工程当试验田：

- **源项目（只读）**：`C:\Users\Ansel\Documents\Automation\V17\PEI_SinoARP_SWT2\PEI_SinoARP_SWT2.ap17`
- 规格：TIA Portal **V17**（`ProjectCompatibilityVersion 17.0.0.0`，不需要 `allow_upgrade`）、
  1 个 PLC（设备与软件都叫 `Sino_PEI`，1155 块）、437 MB / 175 文件。
- 源也可以是 **`.zap17` 归档**：`create_engineering_project` 按扩展名识别，直接把归档路径传给它，
  TIA 会在这一次调用里取回到 `tia/<工作区名>/`（保留归档里的工程名，归档本身不改）。
  **不要**先 `archive_project(retrieve)` 或 `open_project`——那会让 create 以
  `project_already_open` 拒绝。

**造测试项目 = 一次工具调用，只给它源路径**（`create_engineering_project` 属于
`@voltarenyah/dsh-engineering-context`，它再经 `engineeringAccess` 走 TIA 插件）：

```jsonc
create_engineering_project({
  "source_project": "C:\\Users\\Ansel\\Documents\\Automation\\V17\\PEI_SinoARP_SWT2\\PEI_SinoARP_SWT2.ap17",
  "dry_run": false
})
```

它做四件事：TIA 打开源项目 → 把它**另存进当前工作区** `tia/<工作区名>/` → 把源树导出到 `source/`
→ 逐设备把块逻辑转译进 `knowledge/<设备名>/<设备名>_knowledge.db`（经工程知识图谱插件的
`knowledgeGraph` 服务；图谱插件不在、或它的引擎没构建时，这一步只报"图谱未建成"，流程照常成功）。
之后的功能测试（`open_project` / `export_blocks` / `import_blocks` / `compile_plc` / `project_info` …）
全部对这个**测试项目**做；源路径只是"从哪一份开始"的常量，记住它就够了。

- **不要复制源项目，也不要在工作区之外建目录**（`C:\` 根下尤其不要：那是用户不知情的垃圾文件）。
  目标目录由工作区根（会话 cwd）决定，工具不接受目标路径；`tia/` 与 `knowledge/**/*.db*`
  （尾随 `*` 覆盖 SQLite 的 `-wal` / `-shm` / `-journal` 旁挂文件）会被写进工作区的 `.gitignore`。
  本仓库里它落在 `tia/<工作区名>/`（目录名取工作区标题或文件夹名），
  源树在 `source/`，图谱库在 `knowledge/<设备名>/`。
- 一个工作区管一个工程：`source/_dsh-engineering-context.json` 记着这棵树属于哪个工程，
  换工程要先有意清掉，否则工具以 `source_belongs_to_another_project` 拒绝。
- 源项目不会被改：工具不删、不改原工程文件，`SaveAs` 只改"控制器持有的位置"，源目录的文件仍在。
  **但"打开"本身会让 TIA 往源目录写临时文件**（实测 `IM\SearchIndex\segments_*`、
  `TMP\StandardMotionControl\cache.tmp`）—— 核对"源未被改动"时把这两类排除掉。
- `dry_run` 默认 true **且不打开工程**；`with_window` 默认 true（屏幕上看得到导出过程），无人值守传 false。
- 大工程慢：本项目实测 headless 打开 8.3 s（TIA 冷启动可到 70 s），导出上千块是分钟级
  （237 块用 87 s，见 §6 的超时提醒），编译"常需 10 分钟以上"。会话的 `requestTimeoutMs`
  先放大到 600000，超时未回不等于失败。
- 这三个插件都要在会话里加载才可用（TIA 接口、工程上下文、工程知识图谱）；建库还要求图谱插件的引擎
  `packages/dsh-engineering-graph/engine/bin/EngineeringGraph.Engine.exe` 存在 —— 它缺席时
  `create_engineering_project` 只报"图谱未建成"，其余照常。`Get-Process TiaOpennessV17Min.Controller`
  有进程即说明接口插件已加载（见 §6「怎么判断启动成功」）。

---

## 8. 并行会话文件认领（dsh-file-claim）

多个会话同时在本仓干活时，用 `dsh-file-claim` 协调"谁在改哪个文件"。**用法不需要看本节** ——
插件每次会话都把协议注入系统提示，8 个工具自带说明；这里只记本仓约定与几条实测边界。

### 现状与作用域

- 它装在**日常** profile（`~/.dsh/profiles/desktop` 的 bundle 层），由 `dsh plugin add` 装入。
- ❌ 本仓蓝图的 `profile/dsh-automation-suite/package.json` **没有**它，所以 §6 的验收环境
  （独立 `DSH_HOME`）里**不会有**这套工具。要在验收环境用它，得把包名同时加进蓝图的
  `dependencies` 与 `dsh.profile.bundles`；别指望两边自动同步。
- 认领状态落在**会话所属的工作区**，跨 DSH 进程可见；认领者是**会话 id**，不是模型名 ——
  两个会话用同一个模型也互不继承认领。
- ⚠️ 认领范围跟**会话启动时的工作区**走，中途换 cwd **不会**换认领范围。实测：在本仓里开会话、
  `working_directory` 切到别处后再 `claim_files("AGENTS.md")`，边车写进了会话原来的工作区
  （旁挂的 `.dsh-file-claim.lock` 反倒落在进程 cwd）。所以要靠它保护本仓，就在本仓**开会话**
  （cwd = 仓库根），别指望中途切换。

### 认领粒度：只在真有并发时认领

- ✅ 改前 `claim_files`，改完立刻 `release_files`；会话结束（`agent/disposed`）插件自动释放。
- ✅ 按**包目录**认领，覆盖全部后代：`claim_files({ paths: ["packages/dsh-ui-plc-source/"] })`。
- ✅ 只在另一个会话确实活跃、且可能碰同一批文件时认领（`claim_status` 看得到它）。
- ❌ 单会话里的逐行小修不必认领：每条认领路径都会在工作区落一个 `<path>.dshclaim` 边车。
- ❌ `claim_files({ paths: ["."] })` 认领整仓只用于"我明确要独占全仓"的场合，不是日常操作。

### 撞车时的三条出路（守卫是"拒绝"，不是"覆盖"）

1. 等对方 `release_files` 后再写；
2. 对方心跳过期（默认 `staleMs` 2h；**进程已死的会话在下次活动时按 pid 立即清理**，
   通常不用等满 2h）后 `claim_files({ paths: [...], force: true })` 接管；
3. `pending_write` 把改好的内容 + git HEAD base 塞进待合并区：本仓是 git 仓库，这条路可用；
   对方 release 时无冲突**自动三方合并**落盘，有冲突则留标记，由 `pending_apply` 手动合。

### 守卫边界：挡不住不走 DSH 工具链的写

- 拦 `write` / `edit` / `pwsh`（重定向目标 + `Set-Content`、`Out-File`、`Copy-Item` 等显式写命令）
  / `bash`；**不拦 `read`**；解析不出写入目标就放行（fail-open）。
- `guardCommit` 默认 **false**：`git commit -- <path>` 显式暂存别人认领的文件**不会**被拒。
  要更严就在日常 profile 的 `~/.dsh/profiles/desktop/cordis.patch.yml` 加
  `- id: dsh-file-claim` / `config: { guardCommit: true }`。
- **只挡 DSH 的工具**：别的 CLI、别的 agent、TIA Portal 本体的写入都不认这套。它是一致性约定，
  不是操作系统级文件锁；真需要独占就串行，别指望它。

### 产物：边车与审计，别提交也别手删

- 四种产物都是插件自有状态：`<path>.dshclaim`（认领边车，含持有者与心跳）、
  `<path>.dshpending/`（待合并条目：改好的内容 + git HEAD base）、
  根目录 `.dsh-file-claim.audit.jsonl`（追加式审计，每次 claim / release / 接管 / pending 变更一行 JSON）
  与 `.dsh-file-claim.lock`（跨进程互斥锁，只在崩溃后可能残留）。
- 四种模式已进 `.gitignore`（见该文件末尾说明块）。**不要提交、不要手删** —— 审计是崩溃后对账的唯一证据。
- 它们是普通文件（不是链接），清它们不受 §3 的 junction 红线约束，但同样别用递归删除顺手扫。

### 子 agent

工具在宿主面注册，按 §1「宿主面注册的工具会被每个 agent 继承」，leader 与它派出的子 agent
都能用 `claim_files`。并行子 agent 切包干活时各领一个 `packages/<包>/` 就不会互踩。
---

## 9. 桌面打包（2026-11-07）

Phase 1 壳、Phase 2a 安装器、Phase 2b 的 profile 安装/三方合并/安装期 doctor、Phase 2c 的 DSH/WebView2 自动补齐已实现，并在干净 Windows 11 LTSC 2024 VM 上分别覆盖“无 DSH（WebView2 存在）”与“无 WebView2（DSH 已装）”验收通过（壳 smoke 通过）。契约如下，改动时要保持稳定：

- `scripts/build-app-layer.mjs` — 从当前工作树物化桌面 app layer：
  `node scripts/build-app-layer.mjs --version 0.2.0`。它调用 `build-distribution.mjs` 打包
  （图谱引擎自包含），用 `pnpm install --prod --node-linker=hoisted` 生成真实 `node_modules`，
  检查无 symlink/junction、`@deepseek-ai` 只允许 `cosmokit`/`dsh-brand`/`schemastery`，
  再复制到临时 `DSH_HOME/profiles/dsh-automation-suite` 做**不跑 pnpm** 的 `--dump-config` +
  `doctor.ps1 -Json` 验收。产物在 `dist/desktop/<version>/app/`（gitignored）。
- `scripts/doctor.ps1` — doctor 的唯一实现；`-Json` 必须只输出 JSON，`schemaVersion` 当前为 1；
  `scripts/test-doctor-json.ps1` 校验契约。安装器和壳都调用它，不要复制检查逻辑。
- `scripts/merge-profile.mjs` — 固定 profile 的三方合并（旧用户 patch × 旧基线 × 新基线）；
  只合并用户改过的 `- id:` 块，`- insert:` 政策块以新基线为准；测试在 `scripts/test-merge-profile.mjs`。
- `scripts/dsh-launch.mjs` — 直接调用 `DeepSeek Harness.exe --expose-internals <cli.js>`，
  **不要**从 Node spawn `dsh.cmd`（路径含空格，cmd 引号会失败）。
- `scripts/probe-dsh-web.mjs` — 启动/清理探针：等待 token URL、超时、taskkill 进程树。
- `scripts/probe-dsh-runtime.ps1` — 安装器 bootstrap dry-run：DSH/WebView2/.NET 4.8 检测 +
  官方 `nightly.yml` 解析（折行 scalar）；不下载、不安装。
- `desktop/DshSuite.Shell/` — Phase 1 WebView2 壳（WinForms、Job Object、托盘、单实例、日志）；
  `--smoke-test` 隐藏 WebView2 跑完整启动/导航/清理。构建：
  `pwsh -NoProfile -File desktop/build-shell.ps1 -Version 0.2.0 -SmokeTest`。
- `desktop/installer/` + `desktop/build-installer.ps1` — Inno 安装器：稳定 shell + `app\<ver>` +
  `current.txt` + 快捷方式/卸载；`install-profile.ps1` 负责复制固定 profile、备份并三方合并旧
  `cordis.patch.yml`、写 `install.json`、跑 `doctor.ps1 -Json`（fail 则恢复旧 profile）。
  `bootstrap-dsh.ps1` 在 DSH 缺失时从官方 feed 下载（SHA-512 + DeepSeek Authenticode）并静默安装；
  `bootstrap-webview2.ps1` 已在干净 Win11 LTSC VM 上安装成功（Sandbox 的 EdgeWebView 残留会 `0x80040902`）。
  安装器是 32 位 Inno，所有 PowerShell 子进程必须走 `{sysnative}`/`Sysnative` 的 64 位 PowerShell；
  5.1 下 `Start-Process -RedirectStandardOutput` 的 `ExitCode` 可能为空，WebView2 调用用
  `System.Diagnostics.Process` 读取。
- `desktop/sandbox/` — Windows Sandbox 启动脚本：`dist/` 只读映射为 `C:\dist`，宿主机输出目录
  映射为 `C:\out`；`-Offline` 关闭网络。用于干净安装/升级/卸载测试；WebView2 缺失与 TIA/PLCSIM 不在范围内。
- 设计、目录布局、安装器状态机与验收矩阵见 `docs/desktop-packaging.md`；
  打包前置件索引见 `desktop/README.md`。

构建前置条件：本机 .NET 10 SDK（`%USERPROFILE%\.dotnet10` 会被 `build-distribution` 自动发现）、
DSH 已安装（验调用 app layer 时需要）、pnpm 由 DSH 自带副本自动发现。

---

## 10. 站点文案（`site/`）：可视化改、直接写回源文件

`site/` 是发布到 <https://voltarenyah.github.io/dsh-automation-suite/> 的产品介绍页
（`.github/workflows/pages.yml` 只上传这一目录）。它是**纯静态、无构建**的，文案分散在四处：
首页全部在 `site/index.html`；子页英文在 HTML、中文在 `site/assets/main.js` 的 `I18N`；
架构页段落与两张表在 `site/assets/arch.js`（`I18N` / `COMPONENTS` / `PRESETS` / `GROUPS`）；
`site/content.md` 是英文底稿，手工同步。**手改 HTML 不直观，也没有任何构建能发现改错**。

使用者说「改站点文案 / 文案改起来不直观 / 想在浏览器里改并实时预览 / 改完直接同步到 HTML」时，
**用 `tools/site-editor`，不要盲改文件**：

```powershell
node tools/site-editor/server.mjs        # 默认 http://127.0.0.1:4173/，自动开浏览器；也可双击 start.cmd
```

- 在真实页面里点字就地改：回车保存、Esc 取消；悬浮栏显示来源（`index.html · 第 98 行`、
  `assets/main.js · zh · arch.head.lead`、`assets/arch.js · COMPONENTS[3.role.zh]`），可切四页、
  切 EN/中文、撤销上次保存、看 `git diff site/`、`?plain=1` 原样预览（不注入编辑层）。
- 写回是**按源文件字符区间替换**：属性、缩进、注释、行尾（架构页是 CRLF）都不动；每次保存先校验
  「这段原来是什么」，对不上就 409 要求刷新，绝不盲写；`fs.watch` 让其它标签页自动刷新。
- 参数：`--port <n>`、`--site <dir>`、`--no-open`、`--help`。只监听 `127.0.0.1`，写接口校验
  一次性 token（每次启动重生成、不落盘）+ 同源；站点代码本身不需要任何改动。
- 边界：按钮/输入框内的文字不进入编辑（保证控件可点）；`<title>`/`<meta>` 不参与；子页 EN 改的是
  字典，HTML 里给无脚本场景兜底的英文不同步；`content.md` 仍需手工回写；首页演示对话由
  `components.js` 运行时生成、不可编辑。整段文本节点替换会连带吃掉原来的前后缩进换行
  （对渲染无影响，介意就手工补回）。
- 验收：`tools/site-editor/test/smoke.py`（Python Playwright，41 项；用**副本 + 两个端口**跑，
  步骤见 `tools/site-editor/README.md`）。`tools/` 不进 Pages 上传范围、不是 npm 包，
  不参与 `pnpm -r build/test`。

