# AGENTS.md — TIAOpennessV17Min

本文件是给在本仓库工作的 agent 的项目级约定。用户级约定见 `~/.dsh/AGENTS.md`。

---

## 1. 覆盖矩阵网页必须与代码同步（强制）

`docs/coverage-matrix.html` 是**生成物**，它把官方 TIA Portal Openness V17 手册的能力清单
与本插件的实际适配情况逐条对照（391 条能力条目，可折叠、悬停看说明）。代码进化而网页不更新，
就等于文档在说谎，因此：

- **不要直接编辑 `docs/coverage-matrix.html`** —— 下次生成会覆盖。
- **人工判断只写在 `scripts/coverage/matrix-data.mjs`**：章节状态、逐条说明、前置条件与限制引用。
- **只要改动下列任何一处，就必须重新生成并让校验通过**：
  - `controller/*.cs` 里出现的 Openness 类型 / `using Siemens.Engineering…`
  - `controller/Protocol.cs` 的 `OperationCatalog` 白名单
  - `src/protocol.ts` 的 `OPERATIONS`
  - `src/tools.ts` 的工具与参数（尤其是新增/收回某个控制器已具备的参数）
  - `README.md` §10「已知边界」里对能力范围的描述
- 命令：

  ```powershell
  npm run matrix:build     # 重新生成 docs/coverage-matrix.html
  npm run matrix:check     # 校验网页是否过期（已并入 npm run check）
  ```

- `matrix:check` 在下列情况会**失败**（退出码 1），必须处理而不是忽略：
  1. 网页内容与按当前源码重算的结果不一致（过期）；
  2. `matrix-data.mjs` 里的章节路径在手册目录里找不到（手册换版时会出现）；
  3. 代码引用了某个命名空间，而映射它的章节全部标为「未适配」（= 手工分析过期）；
  4. 章节标为「已适配」，但其命名空间没有任何类型被代码引用（= 状态过期）；
  5. `OperationCatalog` 与 `src/protocol.ts` 的 `OPERATIONS` 不一致；
  6. `TOOL_GAPS` 里记录的"控制器已实现但工具未暴露"缺口被补齐了（应删除该条目）。

- 换 TIA 版本或手册更新时（例如 V17 → V21）：

  ```powershell
  npm run matrix:extract   # 重新抽取 API 面与手册目录快照到 docs/coverage-matrix.sources.json
  npm run matrix:build     # 再生成；路径对不上的章节会直接报错
  ```

- **合规**：网页只引用手册的**目录标题**与**短引用**（每条限制说明不超过两三句，并标注出处主题），
  不搬运手册正文；手册著作权属 Siemens AG。生成器通过解包本机 CHM 读取目录，临时目录用后即删。

---

## 2. 知识库 `skills/` 只走同步脚本，不手改（强制）

`skills/` 是随包出货的 **Siemens Openness 知识库**：31 个上游 skill 的逐字副本 + 我们自己写的路由 skill
`skills/tia-openness/SKILL.md`。它由 `src/skills.ts` 注册成 bundled skill provider（`ctx.inject(['skills'], …)`），
模型按需加载，不占常驻上下文。

- **不要手改** `skills/<name>/SKILL.md`（上游）、`skills/UPSTREAM.json` 与 `skills/LICENSE.siemens.txt`（生成物）；
  它们由 `node scripts/knowledge/build-skills.mjs` 按 pinned commit 重写，手改会被 `skills:check` 的 sha256 拦下。
- 只有 `skills/tia-openness/SKILL.md` 属于本仓库，可直接编辑，但有两条硬约束（`skills:check` 会拦）：
  正文 < **8192** 字符（标准 preset 的 tool-result 修剪阈值 `thresholdChars`），description ≤ **500** 字符
  （会话目录的 `catalogDescriptionMaxLength`，是每个会话都要付的常驻成本），且它引用的每个
  `<name>/SKILL.md` 必须真实存在。
- 命令：

  ```powershell
  npm run skills:build     # 联网：按 UPSTREAM.commit 重取上游，重写 skills/ 与 UPSTREAM.json
  npm run skills:check     # 离线：sha256/字节数、frontmatter、目录清单、上游依赖图、路由 skill 的引用与体积
  ```

  `skills:check` 已并入 `npm run check`。换上游版本：改 `scripts/knowledge/build-skills.mjs` 的
  `UPSTREAM.commit` → `skills:build` → 复核 `UPSTREAM.json` 与路由 skill 的引用路径 → `skills:check`。
- **口径**：上游是 TIA Portal **V21** 的语义（modular assemblies、`.s7dcl`/`.s7res`、LTS 链重启），
  本插件只做 **V17** 的块级读写。所以上游文本是「Openness 能不能做」的证据，**不是**「本插件实测过」的证据；
  写进 `docs/` 或 README 的能力结论必须以 V17 实测为准。
- 工具描述里那句 ``Troubleshooting: load the bundled `tia-openness` skill …`` 由 `src/tools.ts` 的
  `KNOWLEDGE_HINT` 统一追加，**不要删**：本文件只在**本仓库目录内**生效，运行时在用户项目里调用插件的
  模型读不到它，工具描述与 skill 目录才是它真正看得见的位置。
- `scripts/dsh-runtime-cache.mjs` 的 `RUNTIME_ROOTS` 现在多一个 `@deepseek-ai/dsh-skill`（抽取 33 个包）：
  好让 `test/07-skills-registry.test.mjs` 把 provider 挂到**真实**注册表上验证 —— 手写的替身注册表
  证明不了 candidate/definition 会被真实校验接受。缓存的可复用条件因此是"宿主版本一致**且覆盖本包所需的
  全部 root**"（不是逐字相等），这样多个插件共用同一份缓存时不会互相反复重抽。
- 改动 `src/*.ts` 后记得 `npm run matrix:build`（覆盖矩阵的代码指纹会变，`matrix:check` 会失败）。

---

## 3. 常规命令

```powershell
npm run build            # tsc 编译 TypeScript 到 lib/
npm run build:controller # 构建 C# 控制器（需要本机 TIA Portal V17 与 NuGet 源）
npm test                 # node:test 套件
npm run check            # build + test + matrix:check + skills:check
```

## 4. 其他约定

- 控制器新增能力时，优先补齐 `matrix-data.mjs` 中的对应叶子状态，再跑 `npm run matrix:build`；
  生成器会比对代码引用与手工状态，漏改会在 `matrix:check` 里暴露。
- 覆盖矩阵的"证据"必须可回溯：说明里引用具体文件与行号，或引用手册的主题名，
  不要写"应该/大概"这类无法核对的表述。
- 知识库的"证据"同理：引用上游文件时标出 `<name>/SKILL.md` 与上游 commit（`b5c7041`），
  不要把上游结论与 V17 实测混在一句话里。
