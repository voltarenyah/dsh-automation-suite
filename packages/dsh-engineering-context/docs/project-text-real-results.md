
## 真机实测结果（2026-11-04，项目副本 SWT2_PEI_1026_Night）

- **T1 ✅**：`source=en-US`（非 reference）导出成功；表头 `en-US*`，33,045 行，6,535 行源非空；两源的 `Internal ID` 集合一致（33,045）。
- **T5 ✅**：把一条已有中文的 `zh-CN` 单元格清空后导入，再导出该条变为空 → **空白 = 清空**。
- **T6 ✅**：给一条原本空白的目标行填 `DSH_T6_验证中文`，导入后再导出可见 → 可以给原本没有 item 的文本新建。
- **T18 ✅**：`ListPlcObjects(include_attributes=true)` 对 1,155 块全部返回 `ProgrammingLanguage`；F 块 54 个（F_DB 35 / F_LAD 17 / F_FBD 2）。
- **全量文件导入**：`state=Warning`，13,637 条 `is read-only and therefore cannot update value`；0 Error。T5/T6 仍生效。
- **子集导入**：只保留表头 + 1 条要改的行，导入 `state=Warning`（仅 “version property is missing” + 完成提示），目标文本写入成功。
  → 结论：**合并文件应只保留被翻译的行**；全量导出文件会让 TIA 尝试更新所有只读对象。
- **headless**：`with_window=false` 下 OpenProject / ListPlcObjects / export / import / close 全部成功；没有 “Export Completed” 模态框。
  全量导入耗时约 92.6 s（含 33k 行文件）。
- 未做：T4 的目标语言激活许可（本次 target 已 active）、T7/T8 的真实部分失败、T14 重开/SaveAs、T16 真机指纹对比；`@e965/xlsx` 生成文件的真实导入已验证（见下）。

## 库选型实测（2026-11-04）

- **ExcelJS 4.4 读不了 TIA 导出**：`workbook.xlsx.readFile()` 抛 `Cannot read properties of undefined (reading 'sheets')`。TIA 的 OOXML 使用 `x:` 前缀、`sheet.xml` 和 `R2f…` 关系 id，ExcelJS 不兼容。
- **`@e965/xlsx` 0.20.3（SheetJS 维护 fork）可读可写**：读取 33,045 行/22 列成功；用生产 `mergeTextWorkbook` 生成 1 行子集后，真实 TIA 导入成功，再导出可见 `DSH_E965_验证`，日志只有 “version property is missing” 与完成提示，`Error=0`。
- 因此依赖改为 `@e965/xlsx`（Apache-2.0），不再使用 `exceljs`。


## `project_translate(plan)` 真实数据（2026-11-04）

用真实 33,045 行 `en-GB → zh-CN` 导出 + 真实 `blocks.json`（1,155 块）跑工具本体，TIA 服务用 fake：

```json
{"rows": 33045, "selected": 7841, "unique": 5576, "excluded": 25204, "fBlocks": 54}
```

- 选中 7,841 行、去重 5,576 条；F 块 54 个被排除；
- 说明 `programmingLanguage=F_*` 的排除和 `scope=plc-comments` 在真实数据上可用；
- 该测试不启动 TIA，只验证 XLSX/filter/plan 代码。

## 完整 `project_translate(plan → apply)` 真机 E2E（2026-11-05）

用真实 TIA、真实 `projectTextAccess`、`project_translate` 工具本体，对一个块注释做单行翻译：

```json
{"plan": {"rows":33045,"selected":1,"unique":1,"excluded":33044,"fBlocks":54},
 "apply": {"state":"Warning","coverage":{"translated":1,"selected":1},
           "fingerprints":{"Comments":["202_VocDoorGeneral"],"Code":[],"Interface":[],"Properties":[]},
           "codeChanged":false}}
```

- `plan` 按 `path_prefix` + `text_types=block_comment` + `max_rows=1` 选中 1 行；
- `apply` 导入 `DSH_E2E_验证中文`，再导出覆盖率 1/1；
- 指纹只有 `Comments` 变化，`Code` / `Interface` / `Properties` 为空 → **只改注释、未改代码**；
- `state=Warning` 仍是 “version property is missing”，不是失败。

这同时验证了 T16（真机指纹）与完整工具路径；未测 T4/T7/T8/T14。
