# 与另一份导出树的交叉比对（AutomationWorkbench）

把**本插件用 Openness 导出的块**与**另一份导出树**（`AutomationWorkbench` 的 worktree，由某个外部工具生成，
不是我做的；我此前把它当作 TIA VCI 是**没有依据的猜测**，这里更正）做对比，
回答"差在哪里、缺什么、谁覆盖得更全"。

比对对象（同一项目、同一 PLC）：

| 侧 | 路径 | 说明 |
|---|---|---|
| **A** | `C:\Users\Ansel\Documents\Automation\V17\PEI_SinoARP_Master_V4.1.3\UserFiles` | 本插件 `export_blocks` 的输出（1151 XML + `_tia-openness-manifest.json`） |
| **B** | `C:\Users\Ansel\AppData\Local\AutomationWorkbench\Project\Fix PEI Import Error\worktrees\master\devices\Sino_PEI\source` | 另一份导出（`Blocks/` + `DB/` + `UDT/` + `Tags/` + `metadata.json`），生成工具未知 |

项目：`PEI_SinoARP_Master_V4.1.3` / PLC `Sino_PEI`。

复现：

```powershell
pwsh -NoProfile -File test-profile\compare-exports.ps1 `
  -Mine '<A 目录>' -Other '<B 目录>' -MaxList 60 -ContentSample 10 -Report C:\tia-openness-test\compare-report.txt
```

---

## 1. 规模

| | A（Openness，本插件） | B（另一份导出） |
|---|---|---|
| 块类对象 | **1151 导出成功 + 1 被拒绝**（`FOB_SAFETY`） | 1097（`Blocks/` 462 + `DB/` 635） |
| UDT / PLC 类型 | **0**（本插件只做块） | 210 |
| 标签表 | **0** | 7 |
| 总文件 | 1152（1151 XML + manifest） | 1315（1314 XML + `metadata.json`） |
| 对象级状态 | 逐块 `verified` + SHA-256 | 1314 个对象全部 `status=Exported`，0 失败 |

A 的块按编程语言分布：`DB 635`、`LAD 268`、`SCL 194`、**`F_DB 35`**、**`F_LAD 17`**、**`F_FBD 2`**。

## 2. 集合运算（只比"块类"：A 的块 vs B 的 `Blocks`+`DB`）

| | 数量 |
|---|---|
| 交集 | **1097** |
| 仅 A 有（我导出了、那份导出没有） | **54** |
| 仅 B 有（那份导出有、我没有） | **0** |

→ **在块的范围内，本插件的覆盖是那份导出的严格超集**：它导出的每一个块，我这里都有；
我另外还多 54 个。

## 3. "以前不支持、现在能导出"的块 = 54 个 Safety (F-) 块

这 54 个块**全部是 Safety 语言**，且 B 的 `metadata.json` 里**完全没有这些对象**。
B 的 metadata 记录 1314 个对象、**全部 `status=Exported`、0 条失败**，所以这批块是**从一开始就不在那份导出里**；
**为什么不在，我没有依据判断**（可能是该工具的过滤/配置，也可能是它的能力边界）——这里只陈述事实。

| 类型 | 语言 | 数量 |
|---|---|---|
| `InstanceDB` | `F_DB` | 31 |
| `FC` | `F_LAD` | 11 |
| `FB` | `F_LAD` | 6 |
| `GlobalDB` | `F_DB` | 4 |
| `FB` | `F_FBD` | 2 |
| **合计** | | **54** |

它们都在 `000_SAFETY_TASK/` 及其子组下（`S00_Common_Part/`、`S01_Cavity_A/`、`S01_Cavity_B/` …），
例如 `000_Main_Safety [FC #1 F_LAD]`、`LMTH_SinaGSafetyControl [FB #157 F_LAD]`、
`DiscrepancyAnalogIn [FB #175 F_LAD]`、`MicroScan3_Cav_A [InstanceDB #143 F_DB]`。

完整清单（含各自所在组）：`C:\tia-openness-test\only-in-openness-export.txt`

## 4. 缺口

### 4.1 双方共同缺口：Safety **F-OB**

`FOB_SAFETY`（Safety F-OB）在 A 侧被 Openness 明确拒绝：

```
The export of block 'FOB_SAFETY' is not permitted.
```

B 侧（那份导出）同样没有它（其 1097 个块类对象里不含任何 F-OB）。也就是说：

* **F-FB / F-FC / F-DB 可以导出**（上面的 54 个），**F-OB 不行**；
* 这是 TIA 的限制，不是插件的 bug；
* 如果需要 F-OB 的源码，只能走 TIA 界面手动导出，或 TIA V20+ 的 Simatic SD 文档格式
  （`ExportAsDocuments`，V17 不支持）。

### 4.2 本插件的真实能力缺口：UDT 与标签表

| 缺口 | 数量 | Openness 是否支持 | 说明 |
|---|---|---|---|
| UDT / PLC 类型（`PlcStruct`） | 210 | ✅ `PlcType.Export`（`PlcSoftware.TypeGroup`） | 本插件按"Min：只做块"的范围**未实现**；补上即可与 VCI 对齐 |
| 标签表 | 7 | ✅ `PlcTagTable.Export` | 同上，未实现 |

B 侧除此之外没有别的类别（没有硬件组态、HMI、技术对象），所以**没有其他隐藏缺口**。

## 5. 内容级一致性：序列化等价

抽样 10 个两侧都有的块，逐个 diff：

| 块 | 我的字节 / 行 | 那份导出的字节 / 行 | 差异行 |
|---|---|---|---|
| `00_Main_CTR` | 71883 / 1942 | 71883 / 1942 | **2** |
| `140_HOL_Master` | 108088 / 2290 | 108088 / 2290 | **2** |
| `BPS_Ext_Back_VQM_DB_Cav_A` | 27170 / 204 | 27170 / 204 | **2** |
| `DB_RAZ` | 14546 / 166 | 14546 / 166 | **2** |
| `G_Open_Press_Blad_Cav_B` | 35263 / 211 | 35263 / 211 | **2** |
| `LAnyAxis_UnpubHomeSyncAxis` | 54060 / 1083 | 54059 / 1083 | **2** |
| `MBS_Front_VQM_DB_Cav_B` | 27167 / 204 | 27167 / 204 | **2** |
| `R_Screen` | 44063 / 228 | 44063 / 228 | **2** |
| `R812_DateReheatMbLastMeasure_B` | 9382 / 170 | 9381 / 170 | **2** |
| `SAUFI_Cav_A` | 8420 / 165 | 8420 / 165 | **2** |

**10/10 的唯一差异是 `<DocumentInfo><Created>` 的导出时间戳**（那一份是 2026-09-16，我这次是 2026-10-13），
其余字节完全相同（个别差 1 字节就是时间戳字符串长度差）。

结论：**两份导出是同一份 Simatic ML，格式可互换** ——
那一份的 XML 可以直接用本插件 `import_blocks` 导入，反之亦然（这一点由逐字节比对支撑，与生成工具无关）。
（差分工件时记得忽略 `<Created>`，否则每次导出都会有一次伪改动。）

## 6. 命名与布局差异（实操要点）

| | A（本插件） | B（另一份导出） |
|---|---|---|
| 布局 | `<用户组路径>/<块名>.xml` | `Blocks｜DB｜UDT｜Tags/<用户组路径>/<块名> [<类型><编号>].xml` |
| 文件命名 | 块名 | 块名 + ` [FB106]` 这类类型编号后缀 |
| 元数据 | `_tia-openness-manifest.json`：`name/group/file/bytes/sha256/verified/declaredName/declaredNumber/programmingLanguage/simaticType` | `metadata.json`：`id/name/sourcePath/category/folder/status/message/exportedFile/contentHash/fingerprints/…` |

两点注意：

1. **PowerShell 通配符陷阱**：那份导出的文件名里带 `[FB106]` 后缀，会被 `Test-Path`/`Get-Content`/`Get-Item`
   当成通配符字符类，必须用 `-LiteralPath`（本仓库的 `compare-exports.ps1` 已处理）。
2. **用本插件导入那份导出树**：把 `import_paths` 指向 `<source>\Blocks` 或 `<source>\DB`，
   默认的 `mirror_groups: true` 就会把 `25_Exch_CTR_Energy_Manag` 这类子目录当作目标组；
   若指向 `<source>` 根目录，`Blocks/`、`DB/` 会被误当成组名。

## 7. 结论与建议

1. **块的范围：本插件 ⊃ 那份导出**（多 54 个 Safety F 块；它没有任何我缺的块）。
2. **要补齐到与那份导出等价**，只需实现 UDT（`PlcType.Export`）与标签表（`PlcTagTable.Export`）；
   两者都是现成的 Openness API，属"未实现"而非"不可行"。
3. **F-OB 谁都导不了**（Openness 明确禁止，B 侧也不含），需要时走 TIA 界面或 V20+ 的 Simatic SD 文档。
4. **两者产物可互换**（序列化等价），因此可以：用那份导出树做基线，用本插件做模型驱动的
   定向读取/改写，互不冲突。
