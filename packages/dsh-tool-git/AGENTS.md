# AGENTS.md — dsh-tool-git（本仓内的 vendor 副本）

本文件是给在本目录工作的 agent 的项目级约定。仓库级约定见根 `AGENTS.md`；用户级见 `~/.dsh/AGENTS.md`。

---

## 1. 这是 vendor 副本，不是本仓原创代码

| 项 | 值 |
|---|---|
| 上游 | <https://github.com/lxj808624/dsh-tool-git> |
| 导入版本 | tag `v0.1.3`（commit `2347e3d`） |
| 导入方式 | `git clone --branch v0.1.3 --depth 1` 后**压平**拷入，未保留上游 git 历史 |
| 许可 | MIT（见 `LICENSE`） |

**压平导入时丢掉、且不要从上游带回来的东西**：

- `.git/` —— 上游历史不进本仓（与 `dsh-tia-openness-v17-min` 的迁移方式一致：压平为单提交）。
- `.github/workflows/ci.yml` —— GitHub 只读仓库根的 `.github/`，放在包目录里是死文件。
- `pnpm-lock.yaml`、`pnpm-workspace.yaml`、`.npmrc` —— 这三者归 monorepo 根所有。
  上游那份 `pnpm-workspace.yaml` 只有 `allowBuilds` / `minimumReleaseAge` 两个键，是
  **pnpm 11 专有**配置；本机实际跑的是 pnpm 9.12.0（根 `packageManager` 触发自动切换，
  锁文件 `lockfileVersion: 9.0`），这两个键在本仓没有意义，不要搬进根配置。

### 包名保持上游的 `dsh-tool-git`（不加 scope）

刻意的决定。理由：它是第三方插件的 vendor 副本，改名会把上游的包名与文档一起改掉，
也让将来与上游 diff 变得困难。

因此根 `AGENTS.md` 里那条"包名与 patch 名必须逐字一致"落在本包上是：
`package.json` 的 `name` 与 `cordis.patch.yml` 里 `insert[].name` **都**是 `dsh-tool-git`（无引号，
不以 `@` 开头，不需要 YAML 引号）。**改任一处必须同步另一处。**

⚠️ 连带后果：**不能把本包以同名发布到 npm**（`dsh-tool-git` 已被上游占用）。若要发布，
要么改用本仓 scope（`@voltarenyah/dsh-tool-git`，需同步改 patch 的 name），要么只走
`pnpm pack` 出 tarball 内部分发。本包目前没有 `private: true`，所以 `pnpm -r publish`
**不会**自动跳过它 —— 发布前必须先决定这件事。

## 2. 开发期 `@deepseek-ai/*` 不从 npm 装（强制）

上游把 `@deepseek-ai/*` 声明为 devDependencies，从 npm 公开 registry 解析。**本仓不许这样**：

- 公开 registry 上这条线止于 `0.1.0-rc.6`，而本仓库对标的宿主是 **0.2.1-rc.2**（2026-10-19 起）；
- 拿旧副本做类型检查/跑测试 = 对着错误的 API 面验收，正是根 `AGENTS.md` D19 禁止的形态。

改为复用本仓既有机制（与 `packages/dsh-tia-openness-v17-min` 同一套）：

```powershell
pnpm --filter dsh-tool-git run link:runtime
```

`scripts/link-dsh-runtime.mjs` 把 `<DSH_HOME>/plugin-runtime/node_modules/@deepseek-ai/*`
junction 进本包的 `node_modules/@deepseek-ai/`。抽取缓存由 `scripts/dsh-runtime-cache.mjs`
按需从**已安装 app 自己的 `resources/app.asar`** 生成，`runtime.json` 记录宿主版本，
宿主升级后自动重抽。`tests/global-setup.mjs` 让 `vitest` 首次运行时自动做同样的事。

- `RUNTIME_ROOTS` 必须覆盖 `src/` 与 `tests/` 里**直接 import** 的每个 `@deepseek-ai/*` 包。
  当前是 `dsh-tools`、`cordis`、`schemastery`、`dsh-system-prompt`。
  **新增一个直接 import 就要同步加进 `RUNTIME_ROOTS`**，否则裸 checkout 会解析失败。
  只被间接依赖的包不用列 —— 链接是 junction，Node 会解析真实路径并沿
  `plugin-runtime/node_modules` 这个扁平树向上找。
- `plugin-runtime` 由本仓所有插件**共享**（同一个 `DSH_HOME`）。`ensureRuntimeCache()` 光比对
  版本号不足以判断缓存可用，所以本包的副本额外用 `cachedRootsPresent()` 校验根包齐全 ——
  这是相对 `dsh-tia-openness-v17-min` 那份的**有意改进**，不要"对齐"回去。

## 3. `src/dsh-runtime.d.ts` 必须与用到的 API 面同步（强制）

抽取出来的运行时**一个 `.d.ts` 都没有**（app 的生产构建剥掉了类型声明），但每个包的
`package.json` 仍声明 `"types": "./lib/types/index.d.ts"`，于是 `tsc` 报 `TS7016`。
本包的解法与 `dsh-tia-openness-v17-min` 一致：手写环境声明 `src/dsh-runtime.d.ts`。

维护规则：

- 这个文件必须是**脚本**（顶层不能有 `import`/`export`），否则 `declare module` 会变成
  模块体增强而不是全局模块映射。
- 声明要**照真实实现写**，不许用无 body 的 `declare module`、不许把整个模块或某个符号
  声明成 `any`、不许 `@ts-ignore` / `as any` 来消错。测试跑的是真实运行时，签名撒谎会在
  运行期暴露，所以"能过 tsc"不是标准，"与实现一致"才是。
- 新增任何 `@deepseek-ai/*` 的 import 或访问新成员时，同步补这里。
- `tsconfig.json` 的 `include` 是 `["src"]`，所以文件必须待在 `src/` 下；
  `tsconfig.test.json` 另外包含 `tests`，同一份声明也覆盖测试。

## 4. 常规命令

```powershell
# 自带 pnpm 的位置随宿主升级会变（0.2.1-rc.2：resources\runtime\primary-runtime\dependencies\pnpm\bin\；
# 0.2.0-rc.2：resources\runtime\pnpm\bin\）—— 脚本里按候选列表探测，别写死。
$pnpm = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.mjs"

node $pnpm --filter dsh-tool-git run link:runtime   # 裸 checkout 首次
node $pnpm --filter dsh-tool-git run build          # tsc 声明 + tsdown → lib/
node $pnpm --filter dsh-tool-git run typecheck      # tsc -p tsconfig.json && tsc -p tsconfig.test.json --noEmit
node $pnpm --filter dsh-tool-git run test           # vitest（对真实运行时 + 真实 git 临时仓库）
```

本机 `pnpm` 不在 PATH 上，且根 `package.json` 的 `packageManager` 会让随 DSH 分发的 pnpm（0.2.1-rc.2 上是
11.28.5）自动切到 **9.12.0**。别据此推断成 11.x 的配置语义。

`prepare`（`tsdown --config tsdown.prepare.config.ts`）是为 GitHub 安装准备的消费侧构建，
在 workspace 内 `pnpm install` 时**也会触发**，这是上游行为，保留。它把 `@deepseek-ai/*`
当外部依赖处理（打包期解析不到是正确的，运行期由 profile 提供）。

### `deps.neverBundle: true` 是两个 tsdown 配置里不能删的一行（重要）

上游没有这个选项，因为它把 `@deepseek-ai/*` 装成 devDependencies，构建期"解析得到"；
本包改成 `link:runtime` 之后这个选项变成**必需**，原因是一个会静默出错的陷阱：

- `link:runtime` **之前**，rolldown 解析不到 `@deepseek-ai/*`，于是把它们当外部依赖 —— 产物 57.78 kB，正确；
- `link:runtime` **之后**，junction 让它们变得可解析，rolldown 就把整个运行时**内联进产物** ——
  产物 391.40 kB，注入了 cosmokit / cordis / dsh-scope / dsh-tools 等私有副本。

后者是严重的功能性错误：插件会在自己的 bundle 里拿到一份私有的 `dsh-tools`，
它注册工具的目标就不再是宿主 profile 的那份注册表。而且它只在"恰好链接过运行时"时才发生，
所以很容易在只跑过一次 `link:runtime` 的机器上被漏掉。

`neverBundle: true` 的语义正是所需：按包名的 import 一律保持外部、不解析，相对 import 照常打包。
**验收口径**：`lib/index.mjs` 应约 **57.78 kB**，且开头只有
`import z from "@deepseek-ai/schemastery"` 与 `import { defineTool } from "@deepseek-ai/dsh-tools"`
两条 `@deepseek-ai` 语句。若产物变成 ~390 kB 或内含 `@deepseek-ai/*` 的实现，就是这一行被删了。

## 5. 与上游同步

```powershell
$tmp = Join-Path $env:TEMP 'dsh-tool-git-src'
cmd /c rmdir /s /q "$tmp"    # 若存在
git clone --quiet --branch v<新版本> --depth 1 https://github.com/lxj808624/dsh-tool-git.git "$tmp"
```

然后逐文件比对并拷入，**保留本仓的四处差异**：

1. `package.json` —— 去掉 `peerDependencies` 与 `devDependencies` 里的全部 `@deepseek-ai/*`，
   加 `link:runtime` 脚本；
2. `vitest.config.ts` —— 加 `globalSetup: ['tests/global-setup.mjs']`；
3. `tsdown.config.ts` 与 `tsdown.prepare.config.ts` —— 各加 `deps: { neverBundle: true }`
   （理由见第 4 节末尾；上游没有这一行，照搬上游会把运行时内联进产物）；
4. `tests/global-setup.mjs`、`src/dsh-runtime.d.ts`、`scripts/*.mjs` —— 本仓新增，上游没有。

上游 `package.json` 里的 `repository` / `homepage` / `bugs` 保留指向上游：代码是他们的，
出处不该被抹掉。

## 6. 危险操作

- ❌ 不要用 `rm -rf` / `Remove-Item -Recurse` / .NET `Directory.Delete` 清本包的 `node_modules`：
  里面 `@deepseek-ai/*` 是指向 `<DSH_HOME>/plugin-runtime` 的 junction，跟进式删除会毁掉缓存
  （同类事故见 `packages/dsh-tia-openness-v17-min/docs/ECOSYSTEM-COMPAT.md`）。
  拆链接只用 `Remove-Item -Force`（不加 `-Recurse`）或 `cmd /c rmdir "<路径>"`。
- ✅ 重新链接用 `pnpm --filter dsh-tool-git run link:runtime -- --force`：目标若是链接只 `unlink`，不下降。
