# 输出接口与目录约定（给 agent 与使用者）

这一份说明回答三件事：**工具怎么调**、**导出到哪里、目录长什么样**、**有没有清单**。

---

## 1. 工具与统一输出信封

26 个工具（`inject: ['tools']`）。**完整的参数与返回契约在
[`EXTENDED-SURFACE.md`](EXTENDED-SURFACE.md)**，这里只列工具清单与信封。

| 工具 | 作用 | 写入 | 默认 dry-run |
|---|---|---|---|
| `open_project` | 打开/附加 TIA Portal V17 项目 | 仅 `allow_upgrade` | 否 |
| `export_blocks` | 导出**程序块 / PLC 类型(UDT) / 标签表**为 Simatic ML XML | 否（只写文件系统） | 否 |
| `import_blocks` | 从 Simatic ML XML 或 SCL/STL 外部源导入上述三类对象 | **是** | **是** |
| `compile_plc` | 编译 PLC 软件 | 是（编译状态） | **是** |
| `close_project` | 关闭项目（可选保存/关 TIA） | 是（会话） | **是** |
| `create_project` | 新建工程并保持打开 | **是** | 否 |
| `save_project` | 保存 / 另存工程 | **是** | 否 |
| `archive_project` | 归档当前工程 / 取回归档并打开 | 归档只写文件，取回打开工程 | 否 |
| `project_info` | 只读：工程属性、注释、语言、历史、产品、设备树、TIA 设置 | 否 | — |
| `project_languages` | 列出/设置工程语言 | 是（`set`） | **是** |
| `project_texts` | 导出/导入整工程文本（xlsx） | 导出只写文件 | 导出否 / 导入**是** |
| `update_project` | 写仿真支持属性与工程注释 | **是** | **是** |
| `portal_settings` | 列出/修改 TIA Portal 设置项 | 是（`set`） | **是** |
| `list_plc_objects` | 只读：块/类型/标签表(变量,常量)/外部源/监视表/力表/软件单元 | 否 | — |
| `create_plc_objects` | 建组/标签表/监视表/软件单元/单实例 DB | **是** | **是** |
| `delete_plc_objects` | 删块/类型/标签表/监视表/软件单元/组/变量/常量 | **是** | **是** |
| `write_tags` | 建/改/删 PLC 变量与用户常量 | **是** | **是** |
| `set_block_attributes` | 通用 `SetAttribute`（如 OB `Priority`） | **是** | **是** |
| `protect_blocks` | 块 know-how 保护加/解 | **是** | **是** |
| `generate_source` | 由块/UDT 生成 `.scl`/`.awl`/`.db`/`.udt` | 只写文件 | 否 |
| `watch_and_force_tables` | 监视表建删导出导入、力表导出导入 | **是** | **是** |
| `software_units` | 软件单元列表/建删/关系增删 | **是** | **是** |
| `safety_status` | 只读：F 相关全局设置、SafetySettings、运行时组 | 否 | — |
| `set_safety_settings` | 写 `SafetyModificationsPossible` / `UsernameForFChangeHistory` | **是** | **是** |
| `safety_signatures` | 只读：逐块 F 签名 | 否 | — |
| `controller_status` | 控制器与 Openness 环境状态 | 否 | — |

> 工具名保留历史命名：`export_blocks` / `import_blocks` 现在按 `categories` 处理三类"程序对象"
> （`blocks` / `types` / `tag_tables`），默认仍是 `blocks`，所以旧调用行为不变。

**每个工具返回同一个信封**（这就是 agent 看到的 canonical value）：

```jsonc
{
  "ok": true,                       // 操作本身是否成功
  "operation": "ExportBlocks",      // 实际执行的控制器操作
  "dryRun": false,                  // 是否只预演
  "summary": "…一行结论…",
  "data": { /* 操作专属负载，见下 */ },
  "changes": [ { "kind": "file", "target": "…", "action": "created", "detail": "FB_Motor" } ],
  "diagnostics": [ { "level": "info|warning|error", "message": "…", "source": "progress:export" } ],
  "error": null,                    // 失败时 { code, message, details }
  "durationMs": 4173
}
```

模型侧看到的文本由 `render` 生成（人类可读的摘要 + 关键字段 + 失败清单 + 诊断），
`data` 里始终保留完整结构化负载。**操作失败**（如 `block_not_found`）不抛异常，而是
`ok:false` + `error{}`；**传输失败**（找不到 exe、超时终止、协议不匹配）抛错，消息以错误码开头。

---

## 2. 导出：路径与目录结构

`export_blocks` 的必填参数只有 `output_dir`，其余可选：

| 参数 | 默认 | 说明 |
|---|---|---|
| `output_dir` | — | 目标目录（不存在会创建） |
| `categories` | `["blocks"]` | `blocks`（含 DB）/ `types`（UDT）/ `tag_tables` |
| `block_names` / `type_names` / `tag_table_names` | 全部 | 各自类别的对象名过滤；点名的对象不存在 → 报错并列出可用名 |
| `device_name` / `software_name` | 自动 | 项目里有多个 PLC 时选择 |
| `recursive` | `true` | 是否含用户组 |
| `overwrite` | `false` | 已存在的文件默认**跳过**并告警（不覆盖别人的文件） |
| `write_manifest` | `true` | 写清单（见 §3） |
| `export_options` | `with_defaults` | TIA 的 `ExportOptions`：`none` / `with_defaults` / `with_read_only` |
| `dry_run` | `false` | 只列计划、不写文件 |

### 目录结构（三类分开，互不冲突）

```
<output_dir>/
├── _tia-openness-manifest.json          # 清单（§3）
├── <用户组路径>/<块名>.xml               # categories 含 blocks（默认）
├── types/                              # categories 含 types
│   └── <类型组路径>/<类型名>.xml
└── tag_tables/                          # categories 含 tag_tables
    └── <标签表组路径>/<标签表名>.xml
```

规则：

* **文件名 = 对象名 + `.xml`**（不做类型编号后缀；编号记录在清单里）。
* **目录层级 = 该项目里的用户组层级**（块组 / 类型组 / 标签表组三棵独立的树）。
* 组名与对象名里的非法文件名字符会被替换为 `_`；两个对象规范化后撞到同一路径时，
  第二个写为 `<名>~2.xml` 并发一条 `warning` 诊断（不静默覆盖）。
* `blocks` 直接放在 `output_dir` 下（历史布局，保持向后兼容）；`types` / `tag_tables`
  放在各自子目录。

### 真实例子（`PEI_SinoARP_Master_V4.1.3`，1152 块的正式项目）

```
导出 1151 / 1152 个块（1 个 Safety F-OB 被 TIA 拒绝，逐块记录），1152 文件 / 70.6 MB
UserFiles/
├── _tia-openness-manifest.json
├── 000_SAFETY_TASK/…            ├── 010_Cell/…            ├── 20_Press/…
├── 999_Bibliotheque/Fonctions méthode/1001_SCP_IN/SCP_IN.xml
└── LAxisCtrl_Blocks/…

成员表（发往同一项目，只读）：
types/        210 个 XML   （如 types/999_Bibliotheque/Fonctions Procede/Twin_RTD/HMI_Twin_RTD.xml）
tag_tables/     7 个 XML   （如 tag_tables/Table de variables standard.xml、tag_tables/_PC/IO_PC.xml）
```

---

## 3. 清单：`_tia-openness-manifest.json`

有，就在 `output_dir` 根下，`write_manifest` 默认开启。逐字段：

```jsonc
{
  "schemaVersion": 1,
  "protocol": 1,
  "generatedBy": "TiaOpennessV17Min.Controller",
  "generatedAt": "2026-10-13T03:35:39Z",
  "device": "Sino_PEI",                  // 设备名
  "software": "Sino_PEI",                // PLC 软件名
  "outputDir": "C:\\…\\UserFiles",
  "exportOptions": "with_defaults",
  "categories": ["blocks"],              // 本次请求的类别
  "counts": { "blocks": 1151, "types": 0, "tagTables": 0 },
  "objectCount": 1151,                   // 成功写出的对象数
  "blockCount": 1151,                    // 同一数字（向后兼容旧字段）
  "failureCount": 1,                     // Openness 拒绝的数量
  "blocks": [                            // 成功写出的每个对象
    {
      "category": "blocks",              // blocks | types | tag_tables
      "name": "FB_Array_Handling",
      "group": "999_Kautex/",            // 用户组路径（空 = 根组）
      "file": "C:\\…\\UserFiles\\999_Kautex\\FB_Array_Handling.xml",
      "bytes": 19616,
      "sha256": "…",                     // 便于审计/比对
      "verified": true,                  // 写出后读回校验通过
      "element": "SW.Blocks.FB",         // Simatic ML 对象元素
      "simaticType": "FB",
      "declaredName": "FB_Array_Handling",// 文件里声明的名字（与 name 一致才 verified）
      "declaredNumber": "34",
      "programmingLanguage": "LAD"
    }
  ],
  "failures": [                          // Openness 直接拒绝的对象（逐条，不影响其余）
    { "category": "blocks", "name": "FOB_SAFETY", "group": "000_SAFETY_TASK/",
      "file": "…\\FOB_SAFETY.xml", "code": "export_failed",
      "message": "The export of block 'FOB_SAFETY' is not permitted." }
  ]
}
```

**校验语义**：每个文件写出后立刻读回并解析——非空、能解析、`<Name>` 与预期对象名一致，
再算 SHA-256 写进清单。任何一项不过 → `summary.verificationFailed > 0`，整个调用以
`verification_failed` 失败（`data` 里仍带全部已写文件与失败项），**不会**"没抛异常就算成功"。

用清单独立复核（可直接跑）：

```powershell
$u = '<output_dir>'
$m = Get-Content "$u\_tia-openness-manifest.json" -Raw | ConvertFrom-Json
$bad = foreach ($o in $m.blocks) {
  if ((Get-FileHash -LiteralPath $o.file -Algorithm SHA256).Hash.ToLower() -ne $o.sha256) { $o.name }
}
if ($bad) { "哈希不一致: $($bad -join ', ')" } else { "全部 $($m.objectCount) 个文件与清单一致" }
```

---

## 4. 导出操作返回的 `data`（agent 直接可读）

```jsonc
{
  "device": "Sino_PEI", "software": "Sino_PEI",
  "outputDir": "C:\\…\\UserFiles",
  "exportOptions": "with_defaults",
  "categories": ["blocks"],
  "blockCount": 1151,                       // 计划/写出的对象总数（历史字段名）
  "counts": { "blocks": 1151, "types": 0, "tagTables": 0 },
  "dryRun": false,
  "summary": { "exported": 1151, "skipped": 0, "failed": 1, "verificationFailed": 0 },
  "files": [ /* 与清单 blocks[] 同结构，便于模型直接读 */ ],
  "failures": [ /* 与清单 failures[] 同结构 */ ],
  "manifest": "C:\\…\\UserFiles\\_tia-openness-manifest.json"
}
```

`dry_run: true` 时 `files[]` 变成计划条目：`{ category, name, group, file, exists, action }`，
其中 `action` ∈ `create | overwrite | skip`——**建议 agent 先 dry-run 看计划再真导出**。

---

## 5. 导入：类别自动识别 + 组归属

`import_blocks` 的关键点（写入操作，**默认 `dry_run: true`**）：

| 参数 | 默认 | 说明 |
|---|---|---|
| `import_paths` | — | 文件或目录（目录会扫 `*.xml` / `*.scl` / `*.stl` / `*.db` / `*.udt` / `*.txt` / `*.src`） |
| `categories` | 全部 | 只导入指定类别的文件（按 XML 元素自动判定类别：`SW.Blocks.*` / `SW.Types.*` / `SW.Tags.PlcTagTable`） |
| `import_options` | `none` | `override` 才能覆盖已存在对象 |
| `target_group` | 根组 | 目标组路径；在**该类别的组树**里解析；不存在 → `group_not_found`（可用 `create_group` 建） |
| `mirror_groups` | `true` | 目录导入时，用子目录路径作为目标组（导出布局因此可原样导回） |
| `verify` | `true` | 提交后读回项目，逐对象确认存在 + 组一致 + `ModifiedDate` 变化 |
| `dry_run` | `true` | 只出计划（目标块名、是否已存在、冲突、目标组） |

**两条实测出来的硬约束**（见 [`FUNCTIONAL-TEST.md`](FUNCTIONAL-TEST.md) §8.5）：

1. 块必须导入回**它原来所在的组**——导入按"全 PLC 名字/编号唯一"判断，
   进根组时即使 `override` 也会报 `An object with this name or this number already exists`；
2. **导入后要编译，才能再次导出该对象**（"导入 → 编译 → 重新导出"顺序）。

---

## 6. 常用配方

```jsonc
// A. 导出全部块 + 全部 UDT + 全部标签表（一次调用三类）
{ "output_dir": "D:\\exp\\all", "categories": ["blocks", "types", "tag_tables"] }

// B. 只导出三个指定块 + 两个 UDT
{ "output_dir": "D:\\exp\\pick", "categories": ["blocks", "types"],
  "block_names": ["FB_Motor", "FC_Test", "Main"], "type_names": ["MyUDT", "PHYS_VALUE_1"] }

// C. 先预演（不写任何文件），确认文件名/组/冲突
{ "output_dir": "D:\\exp\\all", "categories": ["blocks", "types", "tag_tables"], "dry_run": true }

// D. 把这些导出原样导回（或导到另一个项目）：目录导入 + 自动还原组层级
{ "import_paths": ["D:\\exp\\all"], "dry_run": true }                 // 预演
{ "import_paths": ["D:\\exp\\all"], "import_options": "override", "dry_run": false }

// E. 只导 UDT 到指定组（组不存在时创建）
{ "import_paths": ["D:\\exp\\all\\types"], "target_group": "999_Bibliotheque",
  "create_group": true, "dry_run": false }
```

---

## 7. 已知边界（会影响"哪些数据能导出"）

* **Safety F-OB 不能导出**：`The export of block 'FOB_SAFETY' is not permitted.`（TIA 限制，
  F-FB/F-FC/F-DB 可以导）。这类对象进 `failures[]`，不影响其余导出。
* **ProDiag 语言块不能导出**：`The programming language 'ProDiag_OB' is not supported during
  import and export.`（同样逐条记录）。
* **清单里的时间戳**：Simatic ML 的 `<DocumentInfo><Created>` 每次导出都不同，用它做
  diff/git 时请忽略这一行（其余内容与 TIA 自己的导出逐字节一致，见
  [`EXPORT-COMPARISON.md`](EXPORT-COMPARISON.md)）。
* **本插件不导出**：硬件组态、HMI、技术对象、在线数据——只做 PLC 程序对象（块/类型/标签表）。
