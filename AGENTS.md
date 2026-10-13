# AGENTS.md — dsh-automation-suite

本仓库是 **DeepSeek Harness 插件发行版 Monorepo**（非官方，与 DeepSeek 无关）。
这里是仓库级约定；用户级约定见 `~/.dsh/AGENTS.md`；单个插件的项目级约定见该包自己的 `AGENTS.md`。

---

## 1. 结构与命名

```
packages/*   插件包。每个都是可安装的 DSH bundle（声明 dsh.bundle.patch）
profile/*    profile 蓝图。物化成 ~/.dsh/profiles/<name>/ 后使用
scripts/     Monorepo 级工具脚本
```

新增插件时直接在 `packages/` 下建目录，不需要再走迁移流程。

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
pnpm test          # 插件单测：45 个，44 通过 / 0 失败 / 1 跳过（跳过项见测试文件内说明）
pnpm -r build
pnpm -r typecheck
```

单测需要真实的 `@deepseek-ai/{dsh-tools,cordis,schemastery}`。裸 checkout 首次运行时
`test/helpers/harness.mjs` 会自动触发抽取：

```powershell
pnpm --filter @voltarenyah/dsh-tia-openness-v17-min run link:runtime
```

它从**已安装 app 自己的 `resources/app.asar`** 里，按 `dependencies` + `peerDependencies`
求闭包（32 个包 / 约 8 MB / <1 s），解包到 `<DSH_HOME>/plugin-runtime`，再 junction 到仓库。
`runtime.json` 记下宿主版本，宿主升级后自动重抽。环境变量覆盖：`DSH_APP_ASAR`（asar 路径）、
`DSH_HOME`（harness home）。

**版本必须对齐运行中的宿主**：手动把来源指回 `~/.dsh/profiles/*/node_modules` 会验到旧版本
（那里是 0.1.5-rc.2，宿主是 0.2.0-rc.2），等于用错版本验收。见 `docs/decisions.md` D19。

profile 组合的端到端验收：

```powershell
dsh --profile dsh-automation-suite --dump-config
```

预期结尾出现 `# == @voltarenyah/dsh-tia-openness-v17-min` 与其 `name:` 行。

装 tarball 的验收链路：

```powershell
cd packages/<pkg>; pnpm pack
dsh plugin --profile <临时 profile> add <tarball>
dsh --profile <临时 profile> --dump-config     # 含你的插件行 = 通过了
```

强于 `--dump-config` 的一条：`dsh --profile <p> --dump-config-schema`，若输出里出现该插件的
Config 字段（如 `opennessDir`），说明模块被**真实 import 并读取了 schema**。注意该命令本身
在未装任何插件的 `web` profile 上也返回 exit 1（DSH 既有问题，与插件无关）。

---

## 5. 其它踩过的坑

- `pnpm pack` 对 `@scope/name` 产出的文件名是 `scope-name-<version>.tgz`（剥掉 `@`、`/`→`-`），
  **不要**在脚本里硬编码 `@scope-` 前缀。
- 根 `package.json` 声明 `packageManager: pnpm@9.12.0`，但本机实际使用的是随 DSH 分发的
  pnpm 11.7.0（`resources/runtime/pnpm/bin/pnpm.mjs`）。锁文件由 11.7.0 生成。
- **在 JS 块注释里写 glob 会截断注释**：`profiles/*/node_modules` 里的 `*/` 会提前结束
  `/** … */`，剩下半句被当成代码，报出与真实位置无关的语法错误。写路径用
  `profiles/<profile>/node_modules`，或转义成 `*\/`。
- 从 `cmd.exe` / `Start-Process` 调 `dsh.cmd` 时，安装路径里的空格会被 cmd 剥掉引号
  （`'…\DeepSeek' is not recognized`）。用 PowerShell 的调用运算符 `& $dsh`。
