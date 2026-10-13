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

## 2. 常规命令

```powershell
npm run build            # tsc 编译 TypeScript 到 lib/
npm run build:controller # 构建 C# 控制器（需要本机 TIA Portal V17 与 NuGet 源）
npm test                 # node:test 套件
npm run check            # build + test + matrix:check
```

## 3. 其他约定

- 控制器新增能力时，优先补齐 `matrix-data.mjs` 中的对应叶子状态，再跑 `npm run matrix:build`；
  生成器会比对代码引用与手工状态，漏改会在 `matrix:check` 里暴露。
- 覆盖矩阵的"证据"必须可回溯：说明里引用具体文件与行号，或引用手册的主题名，
  不要写"应该/大概"这类无法核对的表述。
