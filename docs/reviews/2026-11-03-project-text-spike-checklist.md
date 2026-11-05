# 项目文本翻译：待统一实测清单

> 2026-11-03。基于 2026-11-02 的 V17 真机导出（33,045 行）。
> 原则：全部在**项目副本**上做；每次导入前 `archive_project`；先测只读/导出，再测导入。

## A. 源/目标语言

- [x] **T1 source 是否必须是 reference language？** —— 实测 2026-11-04：**不是，en-US 可直接导出**（表头 `en-US*`，33,045 行）
  - 做法：`source=en-US`（active，但 reference=en-GB）→ `target=zh-CN` 导出；再看 `source=fr-FR`。
  - 通过：能导出且表头为 `en-US*`/`fr-FR*`；若报错，记录错误码。
  - 影响：若只接受 reference，换源语言必须临时切 reference（项目写），或走 XML。
- [x] **T2 非 reference 源语言导出后，行/ID 是否与 en-GB 导出一致？** —— 实测 2026-11-04：`en-US` 与 `en-GB` 均为 33,045 行、`Internal ID` 集合一致
  - 通过：`Internal ID` 集合一致（可合并）；否则要 union。
- [ ] **T3 多目标语言**：`target=zh-TW`（先 add active）→ 导出/导入；确认一次一个 target。
- [ ] **T4 target 未激活时的许可流程**：`plan` 应报 `needs_permission`（并给出 before/after）；
  未获用户许可不得调用 `project_languages(add)`；许可后激活成功、记录变化；项目语言配置可回退。
  - 导出报什么错；`project_languages(add)` 后是否可导。

## B. 导入语义（最关键）

- [x] **T5 空白目标单元格 = 跳过还是清空？** —— 实测 2026-11-04：**清空**（清空一条已有中文，导入后再导出为空）
  - 做法：导出现有 zh-CN 文件；清空某条已有中文的 `zh-CN` 单元格；导入；再导出。
  - 通过：原译文保留=跳过；变空=清空（合并时必须逐行填值）。
- [x] **T6 导入能否给"原本没有 zh-CN item"的文本新建 item？** —— 实测 2026-11-04：**可以**（填 `DSH_T6_验证中文` 后导入可见）
  - 做法：选 3 条中文空白的块/网络注释，填中文，导入，切 editing language 到中文查看。
- [ ] **T7 导入 `state` / `resultPath` 语义**：制造一条失败（导出后删/改一个块），看 Warning/Error 与日志。
- [ ] **T8 部分失败**：失败行之外是否已写入；用再导出差异核对。
- [x] **T9 导入是否弹模态框** —— 实测 2026-11-04：headless 下没有模态框；导入/导出/关闭均正常
- [x] **T10 导入耗时** —— 实测 2026-11-04：33k 行全量文件导入约 92.6 s，日志约 5.5 MB；子集导入更快

## C. 行/过滤

- [ ] **T11 ViewPath 解析**：块名、组路径、`Network N`、`Block title/comment`、接口/操作数成员名；做一套解析单测。
- [ ] **T12 过滤后合并**：排除的行是否保持原 `zh-CN` 值（尤其 T5 若为"清空"）。
- [ ] **T13 单源 / 多源（可选）**：
  - 单源：`source_languages=["en-GB"]`，只导 1 份、不合并，得到基线行数；
  - 多源：`source_languages=["en-GB","en-US","fr-FR","de-DE"]`，按 ID 合并，验证
    `LCCF_CipClient`/`LGF_Frequency` 这类只在 en-US/de-DE 的文本能被补上。
  - 断言：单源不触发多源合并逻辑；多源只改变可选源集合，不改变行/ID。
- [ ] **T13b 参数化**：`scope`（plc-comments / plc-all / hmi / all / 自定义）、
  `target_policy`（only_empty / overwrite / fill_empty_keep_existing）分别跑一遍，
  确认只影响选行/写回策略，不影响语言/ID。
- [ ] **T14 `Internal ID` 稳定性**：重开工程、SaveAs 后再导入；确认是否必须同一会话。
- [ ] **T15 指纹**：见 D。

## D. 指纹与"只改翻译不改代码"

> 结论先行：`ImportProjectTexts` 的载荷只有文本对象，TIA 语义上不会改代码；
> **不需要三层验证**。只保留一层最低成本的指纹校验，用来防"我们自己的合并/筛选写错"
> 和 TIA 异常；`PlcChecksum`/XML diff/SyncScan 只在指纹异常时作为排查手段。

- [x] **T16（主）导入前后 `list_plc_objects(include_fingerprints=true)`** —— 实测 2026-11-05：完整工具 E2E 后 `Comments: ["202_VocDoorGeneral"]`，`Code/Interface/Properties` 为空，`codeChanged=false`。
  - 断言：`Comments` 变；`Code`、`Interface` 不变。
  - `Properties` 若变，先确认是不是 `ModifiedDate`/编译状态这类元数据；元数据变化不算代码变化。
  - 若 `Code`/`Interface` 任一变化：停止全量导入，回滚副本，再上 T17/T19 排查。
- [ ] **T17（标签表，无 fingerprint）**：导入前后 `export_blocks(categories=["tag_tables"])`
  或直接比较 `list_plc_objects` 的 tag `name/address/data_type` 不变、只有 `comment` 变；
  也可导出 tag table XML，去掉 `Comment`/`MultiLanguageText` 后比较。
- [x] **T18（F 块：默认排除，不翻译）** —— 实测 2026-11-04：1,155 块全部有 `ProgrammingLanguage`；F 块 54 个（F_DB 35 / F_LAD 17 / F_FBD 2）。
  - **只按 `list_plc_objects` 的 `programmingLanguage` 以 `F_` 开头识别**（F_LAD/F_FBD/F_DB…）；
    **不用组名**（组名是用户任意命名，没有分类语义）。
  - 断言 F 块的 `ViewPath` 不进入 `selected.jsonl`，`jobs.jsonl` 中 F 块 0 条；
    同时确认普通 LAD/FBD/SCL/DB 块没有被误排除。
  - **不做** `safety_signatures` 测试（不翻译就不应触碰 F 块）。
- [ ] **T19（仅排障，不默认跑）**：`PlcChecksum` / 归一化 XML diff / `SyncScan`，
  只在 T16 报出 `Code`/`Interface` 变化时用来定位；不要作为每次导入的例行校验。


## E. 格式/库

- [x] **T22 零改动 round-trip** —— 实测 2026-11-04：ExcelJS 读不了 TIA 导出；生产 `@e965/xlsx` 读取并生成 1 行子集后真实导入成功，目标文本可见，仅 “version property missing” Warning
- [x] **T23 `=` 开头文本** —— 单测覆盖（写入后仍为字符串）；真实 TIA 未单独验证
- [ ] **T24 `ref=`/`Substitutions`/换行**：逐格保持；只改目标语言列。
- [ ] **T25 目标列已有中文**：默认只填空，不覆盖；如需覆盖，用显式 `overwrite`。

## 统一测试记录模板

```jsonc
{
  "test": "T5",
  "projectCopy": "…\\SWT2_PEI_1026_Night.ap17",
  "commands": ["…"],
  "before": "…",
  "after": "…",
  "result": "pass/fail/blocked",
  "evidence": ["path/to/xlsx", "path/to/log"]
}
```
