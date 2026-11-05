# 项目文本翻译：端到端工作流（v1 定义）

> 这份文档回答“从用户 prompt 到导入验证、再到建议 git 提交，中间每一步是什么”。
> 工具/参数/格式见 [2026-11-02-project-text-translation.md](2026-11-02-project-text-translation.md)；
> 待实测项见 [2026-11-03-project-text-spike-checklist.md](2026-11-03-project-text-spike-checklist.md)。
>
> **当前状态**：流程定义完成；代码尚未实现。T1/T5/T6/T18 未实测。

---

## 1. 用户 prompt 必须提供什么

| 输入 | 必填 | 默认 | 说明 |
|---|---|---|---|
| 工程 | 是 | 当前已打开/工作区工程 | 没有就 `open_project`；不要把源项目当试验田 |
| `target_language` | 是 | 无 | 任意 TIA 支持的语言；未激活要先征求许可 |
| `source_languages` | 否 | `[reference]` | 1 个 = 单源；多个 = 可选多源合并 |
| `scope` | 否 | `plc-comments` | 预设或自定义 filter |
| `target_policy` | 否 | `only_empty` | 只补空 / 覆盖 / 补空并保留已有 |
| 术语表 | 否 | 无 | CSV/JSON；没有也能翻 |
| 试点行数 | 否 | 全部 | 先跑 100 行验证 |

Skill 开始前用一句话复述：**“把 `<工程>` 的 `<scope>` 从 `<源语言>` 翻成 `<target>`，只补空/覆盖，F 块不动”**，用户确认后再进入 P1。

---

## 2. 状态机

```
intent
  → preflight（工程/语言/归档/基线）
  → planned（导出+筛选+统计，用户确认范围）
  → translated（模型按批翻译）
  → preflighted（合并文件逐格校验）
  → imported（project_texts 导入）
  → verified（再导出+指纹+标签表）
  → saved（save_project）
  → commit_recommended（git 建议）
  ↘ failed / rolled_back（任一步失败）
```

**不能跳步**：`planned` 必须用户确认；`preflighted` 不通过不得导入；`verified` 不通过不得保存/提交。

---

## 3. 各阶段

### P0 · intent

- 解析 prompt；缺 `target_language` 就问，缺 scope 用默认并告知；
- 明确：F 块不翻译、注释会进入当前模型、导入不可回滚；
- 用户确认后加载 skill，进入 P1。

### P1 · preflight

1. `open_project` / `adopt_open_project`；`project_info(sections=["languages","software"])`。
2. `project_languages(list)`：
   - 源语言是否 active；
   - target 是否 active。**未激活 → 返回 `needs_permission`，征求用户许可**；
     同意后才 `project_languages(active_mode=add)`，记录 before/after；拒绝则停止。
3. `archive_project`（或确认已有归档）；记录归档路径。
4. 基线：
   - `list_plc_objects(include_fingerprints=true)`；
   - 用 `programmingLanguage=F_*` 建 F 块排除集（**不用组名**）；
   - 标签表快照（name/address/data_type/comment）。
5. 进入 P2；此时**只允许**语言激活这一项项目写操作。

### P2 · plan（用户确认范围）

`project_translate(plan)`：

- 按 `source_languages` 导出（1 个就一份；多个才合并，按 `Internal ID` 取非空源）；
- 按 `scope`/filter 选行；套 `target_policy`；
- 排除 F 块、`System Texts`、两端都空、target-only；
- 输出 `plan.json`、`selected.jsonl`、`excluded.jsonl`、统计摘要。

给用户看：

- 按 `Category` / `textType` 的行数（块标题/块注释/网络/标签/UDT/HMI）；
- 需要补的行数、去重后条数、字符数、预计批次数；
- 被排除的 top 理由；
- 前 20 行样例（source → 目标空/已有）。

**Gate**：用户确认“范围/语言/策略”或改参数重跑；记录 `planHash`。

### P3 · translate（当前模型）

- `plan` 产出 `jobs.jsonl` / `unique.jsonl`；skill 给出目标语言、术语表、上下文、
  不翻译规则、输出 schema；
- 行数少（如 ≤200）可直接给模型；行数多按 50–100 条/批，模型回 `translations.jsonl`；
- 每批校验：ID 对得上、占位符/换行保留、`=` 文本不变公式、数字/标识符不翻；
- 不用 TIA；不写工程。

### P4 · preflight（文件级硬闸门）

`project_translate` 合并出一个新的 `translated.xlsx`：

- **只保留表头 + 被翻译的行**；不翻译的行不写进文件，导入不会碰它们；
  （实测 2026-11-04：全量文件会让 TIA 尝试更新所有只读对象，产生 13,637 条 Warning；
  只保留 1 行时仅剩 “version property missing” 的 Warning，文本正常写入。）
- 行数/`Internal ID`/系统列不变（对保留下来的行）；
- 只改 target 列；源列/其他列逐格哈希一致；
- 无公式；`=` 开头仍是字符串；长度 ≤ 32,767；
- 缺行/多行/重复 ID/占位符不匹配 → 拒绝导入，回 P3。

### P5 · import

`project_translate(apply)`：

- 需要 `apply:true` + `planHash` 一致 + 用户明确同意；
- `project_texts(import, update_source_language=false)`；
- 记录 `state`（Info/Warning/Error）与 `resultPath`（导入日志）；
- `state=Warning` 不一定是失败：本次实测全量文件是 13,637 条只读对象 Warning，
  子集文件只有 “version property is missing”；只要 `Error=0` 且再导出覆盖率达标，可继续；
- **headless（`with_window=false`）实测没有 “Export/Import Completed” 模态框**；
- `state=Error` 或大量非只读 Warning → 停止，不保存，按归档回滚。

### P6 · verify

1. 再导出一次（同 source/target），对比 target 覆盖率、未成功行；
2. 源列/其他语言列逐格不变；
3. `list_plc_objects(include_fingerprints=true)`：
   - `Comments` 变；`Code`/`Interface` 不变；
   - `Properties` 若变，确认是 ModifiedDate/编译状态；
4. F 块 0 条被选中；标签表 name/address/data_type 不变、只有 comment 变；
5. 可选 `compile_plc`（不是代码未变的证据）；
6. 失败 → 回滚归档，报告，不保存/不提交。

### P7 · save

- 用户确认后 `save_project`；记录保存位置与 `isModified`；
- 用户拒绝保存 → 报告“工程已改但未保存”，不进入 git 建议。

### P8 · git commit 建议（必须提示）

1. `git status --short` + `git diff --stat`；
2. 判断仓库跟踪的是**源代码树**还是 **`.ap17` 二进制**：
   - 若跟踪 `source/`：先用 `export_blocks` 把当前工程重新导出到 staging，
     只同步变化的 XML（注释），再 `git add`；
   - 若跟踪 `.ap17`：`git add <project>.ap17`；
   - `tia/`、临时 XLSX、日志通常不提交（按仓库 `.gitignore`）。
3. 生成提交信息：
   `i18n(<target>): translate project texts (N rows, <scope>)`
4. **强烈建议提交**，给出精确命令；默认**不自动 commit**，等用户确认。
5. 报告里附：覆盖率、指纹结论、导入 state、提交文件清单。

---

## 4. 错误矩阵

| 失败 | 检测 | 动作 |
|---|---|---|
| target 未激活且用户拒绝 | P1 | 停止，不改语言配置 |
| source 非 reference 被拒 | P2（T1） | 征求切 reference；否则停止 |
| plan 行数明显异常 | P2 | 改 filter 重跑，不翻译 |
| 翻译校验失败 | P4 | 重做该批，不导入 |
| 导入 Error/部分失败 | P5 | 停止，归档回滚，不保存 |
| 指纹 Code/Interface 变 | P6 | 停止，回滚，排查（T19） |
| 标签表非 comment 字段变 | P6 | 停止，回滚，排查 |
| 用户取消 | 任意 | 不写/不保存/不提交 |

---

## 5. 产物

`<workspace>/translations/<project>/<timestamp>/`：

- `plan.json`、`selected.jsonl`、`excluded.jsonl`
- `source-<lang>.xlsx`（单源或多源各一份）、`merged.xlsx`
- `jobs.jsonl`、`unique.jsonl`、`translations.jsonl`
- `translated.xlsx`、`preflight.json`
- `import.log`、`verify.json`、`report.md`、`commit-plan.md`

默认不提交这些中间产物；只提交工程/源代码树和最终报告（按仓库策略）。

---

## 6. Skill 结构

`skills/project-text-translation/SKILL.md`：

1. 触发条件与输入表（§1）；
2. 状态机与 gate（§2/§3）；
3. 每阶段的工具调用、参数、期望输出；
4. 翻译方法：批次、术语表、上下文、不翻译规则、输出 schema；
5. 失败矩阵与回滚；
6. git 提交建议模板；
7. 明确“不要做的事”：不改代码、不碰 F 块、不静默激活语言、不自动 commit。

---

## 7. Excel 处理与依赖（建议）

XLSX 是 OOXML（zip + XML），不能当文本处理；Openness 只负责导出/导入，不提供单元格级读写。
因此**需要引入一个 XLSX 读写库**。

| 方案 | 依赖 | 评价 |
|---|---|---|
| **Node `@e965/xlsx`（推荐，已用）** | npm 运行时依赖（Apache-2.0，SheetJS 维护 fork） | 能读 TIA 的非标准 OOXML；33k 行/4MB 可用；读 buffer、写 buffer，避免 ESM 版 `fs` 缺失 |
| Node `exceljs` | MIT | **实测读不了 TIA 导出**（`model.sheets` undefined）；不适合 |
| C# `DocumentFormat.OpenXml` | NuGet + DLL | 备选；保真度好，但把 XLSX 逻辑塞进控制器 |
| Python `openpyxl` | 外部 Python | 只适合 spike，不作为发行版依赖 |
| 手写 OOXML patch | 无 | 需处理 sharedStrings/richText/styles，风险高 |

**已用 `@e965/xlsx`，放在 `dsh-engineering-context` 的 Node 侧**（不是 TIA 插件）：

- `project_translate` 与翻译 skill 也在 `dsh-engineering-context`；
  TIA 插件不新增该依赖，只新增窄服务 `projectTextAccess`：
  `exportTexts` / `importTexts` / `readLanguages` / `setLanguages` / `archiveProject` / `saveProject`。
- `plan`：读工作簿（表头/语言列/`Category`/`ViewPath`/`Internal ID`），筛选后输出
  `jobs.jsonl`/`unique.jsonl`；**不把 4MB 的二进制直接塞给模型**，模型只看分批的 JSONL/CSV。
- `apply`：**只保留被翻译的行**（表头 + selected），写 target 列；保存为新文件；重新加载做逐格校验；
  再交给 `projectTextAccess.importTexts`。
- 依赖加在 `dsh-engineering-context` 的 `dependencies`；`THIRD_PARTY_NOTICES.md` 记 Apache-2.0；
  用 `pnpm pack` + 临时 profile 验收。
- 已知坑：`=` 开头必须保持字符串（T23）；换行/`ref=` 列/系统列不能丢；
  写回后必须重新读取校验，不能只信内存对象。

**实测（2026-11-04）**：用生产代码 `mergeTextWorkbook` 从真实 33,045 行导出生成 1 行子集，
真实 TIA 导入 `state=Warning`（仅 “version property is missing” + 完成提示），
再导出可见 `DSH_E965_验证` → 生产 SheetJS 路径可用，且不需要 C# 回退。

---

## 8. 仍未定义/待实测

- T1：source 是否必须 reference；
- T5：空白 target 的导入语义；
- T6：导入能否新建目标语言 item；
- T18：`programmingLanguage=F_*` 是否覆盖全部 F 块；
- 用户许可的交互形态（`needs_permission` 返回后由 agent 询问）；
- git 跟踪 `.ap17` 还是 `source/` 的自动判断；
- 多目标语言是否一次任务循环多个 target（参数化，不影响单目标流程）。
