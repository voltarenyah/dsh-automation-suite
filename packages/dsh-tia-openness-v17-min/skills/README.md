# `skills/` — 上游 Openness 知识库（vendor）+ 本插件的路由 skill

这个目录是**随包出货的知识库**：除了下面两个文件，其余内容都是上游逐字副本。

| 文件 | 归属 | 说明 |
|---|---|---|
| `tia-openness/SKILL.md` | **本仓库** | 唯一由我们维护的 skill：把「症状 / 任务」路由到上游文件，并声明版本口径（上游 V21 ↔ 本插件 V17）。由 `src/skills.ts` 注册为 bundled skill provider |
| `UPSTREAM.json` | 生成物 | 上游仓库、commit、每个文件的 sha256 与字节数、许可证、被排除项。**不要手改**，由 `node scripts/knowledge/build-skills.mjs` 重写 |
| `LICENSE.siemens.txt` | 上游 | `siemens/tia-portal-ai-extensions` 的 MIT 许可证全文（Copyright (c) 2026 Siemens AG）。MIT 要求随副本保留，因此它与知识库一起出货 |
| `<name>/SKILL.md` | **上游** | 31 个 Openness skill 的逐字副本，见 `UPSTREAM.json` 的 `skills` |

## 为什么是 vendor，而不是 submodule / 依赖 / 联网

- 插件要能 `pnpm pack` 成一个自洽的 tarball 装进任意 profile：`files` 白名单里的普通文件最可靠，
  git submodule 在 tarball / npm 安装链路里不保证有内容。
- 运行期不联网、不加任何依赖：知识库是**离线资源**，由 bundled provider 直接从包内读取。
- 上游内容是 **MIT**，允许复制与再分发，代价只有一条：附上版权声明与许可证全文 ——
  这就是 `LICENSE.siemens.txt` 与 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) 里那一段的作用。

## 不要手改上游文件

- 上游文件**逐字保留**（包括相对链接 `../openness-testing/SKILL.md`，因此目录结构不能动）。
- 要更新到新的上游 commit：改 `scripts/knowledge/build-skills.mjs` 里的 `UPSTREAM.commit`，
  然后 `npm run skills:build`（联网重取、重写 `UPSTREAM.json`），最后 `npm run skills:check`。
- 平时的 `npm run check` 会跑 `skills:check`（**离线**）：逐个比对 sha256/字节数、校验 frontmatter、
  确保没有计划外的目录，并检查 `tia-openness/SKILL.md` 里引用的每个上游文件都真实存在。
- 只有 `tia-openness/SKILL.md` 可以直接编辑；它有两条硬约束，`skills:check` 会拦：
  - 正文 < **8192** 字符 —— 标准 preset 的 tool-result 修剪阈值（`thresholdChars`），超过就会被压缩掉；
  - frontmatter 的 `description` ≤ **500** 字符 —— 会话目录的 `catalogDescriptionMaxLength`，
    这条是**每个会话**都要付的常驻成本；
  - 另外，正文里出现的每个 `<name>/SKILL.md` 引用都必须真实存在（上游改名时立刻报错）。
- 注册行为本身由测试守着：`test/06-skills.test.mjs` 用替身注册表（含"没有 skills 服务"的 profile），
  `test/07-skills-registry.test.mjs` 把 provider 挂到**真实**的 `@deepseek-ai/dsh-skill` 注册表上，
  验证 candidate 被接受、`get()` 能加载、卸载后目录项消失。

## 版本口径（重要）

上游面向 **TIA Portal V21**：modular assemblies、SIMATIC SD（`.s7dcl`/`.s7res`）、LTS 链重启等都是
V21 语义。本插件只做 **V17** 的块级读写（6 个工具）。因此：

- 上游文件回答「Openness 能不能做 / 怎么做」，**不**回答「这个插件能不能做」；
- 涉及版本专有 API 的段落要按 V17 重新判断，必要时以本机实测为准；
- 本插件的能力边界与已适配范围见 `README.md` §10 与 `docs/`，那是第一方声明。
