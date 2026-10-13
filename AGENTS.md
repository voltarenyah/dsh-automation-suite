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
pnpm run clean:build      # 清构建产物（只碰 lib/ dist/）
```

`clean` 这个名字**不要用**：pnpm 11 有内置子命令会遮蔽脚本。已改名为 `clean:build`。

---

## 3. 危险操作红线

以下每一条都有真实事故记录（见 `packages/dsh-tia-openness-v17-min/docs/ECOSYSTEM-COMPAT.md`）：

- ❌ **禁止**用 `rm -rf`、.NET `Directory.Delete` 等**会跟进 junction/symlink 目标**的递归删除去清 `node_modules`。
  `pnpm run link:runtime` 建立的 junction 指向 `~/.dsh/profiles/**/node_modules/@deepseek-ai/*`，
  跟进目标会**删掉 DSH 运行时包本身**（该文档记录的事故里还连带删掉了源仓库的 `.git` 元数据）。
- ❌ **禁止**在根 `package.json` 里把 `@deepseek-ai/*`（或任何 DSH 运行时包）声明为依赖。
  插件运行期从 profile 的运行时解析拿到它们，根包永远不该有。
- ❌ **禁止**把根 `package.json` 的 `private` 去掉。
- ✅ 正确顺序：**先** `pnpm install`，**再**在需要跑测试的包内 `pnpm run link:runtime`。
- ✅ 要清构建产物，用 `pnpm run clean:build`：它只检查 `lib/`、`dist/`，且遇链接只 unlink、不下降。

---

## 4. 验收链路

在 `pnpm test` 可用之前，以这条链路作为回归验证：

```powershell
pnpm -r build
pnpm -r typecheck
cd packages/<pkg>; pnpm pack
dsh plugin --profile <临时 profile> add <tarball>
dsh --profile <临时 profile> --dump-config     # 含你的插件行 = 通过了
```

强于 `--dump-config` 的一条：`dsh --profile <p> --dump-config-schema`，若输出里出现该插件的
Config 字段（如 `opennessDir`），说明模块被**真实 import 并读取了 schema**。注意该命令本身
在未装任何插件的 `web` profile 上也返回 exit 1（DSH 既有问题，与插件无关）。

`pnpm test` 目前需要 `~/.dsh/profiles/node_modules/@deepseek-ai/{dsh-tools,cordis}` 可解析；
本机这两条 junction 指向已被清理的 npx 缓存、处于悬空状态，所以单测跑不起来。

---

## 5. 其它

- `pnpm pack` 对 `@scope/name` 产出的文件名是 `scope-name-<version>.tgz`（剥掉 `@`、`/`→`-`），
  **不要**在脚本里硬编码 `@scope-` 前缀。
- 根 `package.json` 声明 `packageManager: pnpm@9.12.0`，但本机实际使用的是随 DSH 分发的
  pnpm 11.7.0（`resources/runtime/pnpm/bin/pnpm.mjs`）。锁文件由 11.7.0 生成。
