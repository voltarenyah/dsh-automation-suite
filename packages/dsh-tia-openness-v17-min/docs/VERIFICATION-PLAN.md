# v0.2 新增能力的验证计划（真实 TIA Portal V17，待执行）

本文件是**待执行的测试清单**，不是验证记录。v0.2 新增的 20 个操作（工程数据 8、PLC 数据 9、
F 相关 3）已实现、控制器编译通过、`npm test` 57 项通过、`npm run matrix:check` 与
`skills:check` 通过，但**一次都没有在真实 TIA Portal 项目上跑过**。
跑完本清单后，把结果回填到 [`verification.md`](verification.md) 并更新 `README.md` §0。

接口与参数契约见 [`EXTENDED-SURFACE.md`](EXTENDED-SURFACE.md)；每条能力在
[`coverage-matrix.html`](coverage-matrix.html) 上对应的状态是"按实现标定"，验证后可能需要下调。

---

## 0. 准备

| 项 | 要求 |
|---|---|
| TIA Portal | V17（本机 `C:\Program Files\Siemens\Automation\Portal V17`），Windows 用户已在本地组 `Siemens TIA Openness` |
| 工程 | 一律**用副本**验证（`Copy-Item -Recurse`）。写类操作会改工程内容 |
| F 相关 | 需要装 **STEP 7 Safety** 的 TIA Portal 与一个 **F-CPU** 工程；没有就只跑 `safety_status` 的降级分支 |
| 软件单元 | 需要一个支持软件单元的 CPU/固件工程（`PlcUnitProvider` 才存在）；没有就只验证 `available:false` 分支 |
| 超时 | 在 profile 的 `cordis.patch.yml` 里把 `requestTimeoutMs` 调到 600000（导出 237 块实测 87 s，取回/归档更慢） |
| 启动 | 仓库根 `pwsh -NoProfile -File scripts\start-env.ps1 -Restart`，用带 token 的 URL 打开 |

**替代入口**：不想用 DSH 工具时，可直接打控制器，参数完全相同（JSON 里 `params` 就是工具参数）：

```powershell
controller\bin\TiaOpennessV17Min.Controller.exe --operation ListPlcObjects `
  --params-json '{"categories":["tag_tables"],"include_tags":true}' --pretty
```

---

## 1. 先跑不需要人判断的检查（10 分钟）

```powershell
cd packages\dsh-tia-openness-v17-min
npm run build; npm run typecheck          # 期望 0 错误
npm test                                  # 期望 57 项：56 通过 / 1 跳过
npm run matrix:check                      # 期望 "is current (391 能力条目…)"
npm run skills:check                      # 期望 "skills/ is current … 4229 chars"
controller\bin\TiaOpennessV17Min.Controller.exe --self-test | ConvertFrom-Json |
  Select-Object ok,failedCount,checkCount # 期望 ok=True failedCount=0 checkCount=14
controller\bin\TiaOpennessV17Min.Controller.exe --version | ConvertFrom-Json |
  Select-Object -ExpandProperty operations # 期望 25 个名字，顺序见 EXTENDED-SURFACE.md
```

☐ 1.1 以上全部通过 ☐ 1.2 25 个操作名与 `src/protocol.ts` 的 `OPERATIONS` 逐字一致

---

## 2. 工程与工程数据（`OperationsProject.cs`）

### 2.0 基线：先开一个工程

```jsonc
open_project({ "project_path": "D:\\Verify\\Demo\\Demo.ap17" })
```

☐ 2.0 `ok:true`，`data.plcSoftware.count >= 1`（后续所有 PLC 侧测试都用这个工程）

### 2.1 `project_info`（只读，先跑，它给出后面要用的名字）

```jsonc
project_info({ "sections": ["attributes","comment","languages","products","software","settings"],
               "include_attribute_infos": true, "history_limit": 20 })
```

**期望**
- `attributes.name/path/author/version/sizeKB/creationTime/lastModified` 与 TIA 里"项目属性"一致；
  `attributes.attributeInfos` 非空（每个元素有 `name`/`accessMode`）。
- `comment.languages` 至少一条（TIA 的"项目注释"里写过什么就应看到什么）。
- `languages.supportedLanguages` 含 `zh-CN`/`en-US`，`editingLanguage` 与 TIA 的"项目语言"一致。
- `products.items` 是实际用到的产品（如 "STEP 7 Professional V17"）。
- `software.items[0].blockCount` 与 `export_blocks` 报的块数一致。
- `settings.folders` 含 `General`，其中有 `SearchInProject`（bool）与 `UserInterfaceLanguage`（CultureInfo）。

**失败时看**：`project_not_open`；`attributes` 缺字段说明该属性在 V17 不暴露（把结论记进矩阵）。

☐ 2.1 各段字段与 TIA 界面对得上 ☐ 2.2 `settings.folders` 有 `General` ☐ 2.3 无字段报 `*Error`

### 2.2 `project_languages` 的 list 与 set

```jsonc
project_languages({ "action": "list" })
project_languages({ "action": "set", "active_languages": ["de-DE"], "active_mode": "add",
                    "editing_language": "de-DE" })
project_languages({ "action": "set", "active_languages": ["de-DE"], "active_mode": "remove" })
```

**期望**：set 直接生效，报 `added:["de-DE"]`；
`activeLanguages` 含 `de-DE`，`editingLanguage: "de-DE"`，TIA 的"项目语言"编辑器里同步变化；
remove 后 `removed:["de-DE"]`。
传一个工程不支持的语言（如 `"xx-XX"`）→ `language_not_found` 且 `details.available` 列出支持的语言。

⚠️ 改完编辑语言记得改回来（`en-US` 或原来的），否则工程注释/标签注释会落到别的语言上。

☐ 2.4 list 与界面一致 ☐ 2.5 真跑生效且可回退 ☐ 2.6 未知语言报 `language_not_found`

### 2.3 `update_project`（仿真支持 + 工程注释）

```jsonc
update_project({ "simulation_during_block_compilation": true })
update_project({ "comment_language": "en-US", "comment_text": "verified by v0.2 plan" })
```

**期望**：直接生效并给出 `before/after/changed`（`changed:true`），
TIA 里"项目属性 → 编译时支持仿真"复选框同步；注释在"项目注释"里出现。
`comment_language` 未激活时 → `comment.changed:false` + `reason`（**这是预期行为**，语言必须先激活）。
两个参数都不给 → `invalid_params`。

☐ 2.8 仿真属性双向可切 ☐ 2.9 注释写入可见 ☐ 2.10 未激活语言给出 reason 而不是静默失败

### 2.4 `portal_settings`（list / set）

```jsonc
portal_settings({ "action": "list" })
portal_settings({ "action": "set", "folder": "General", "setting": "SearchInProject", "value": false })
portal_settings({ "action": "set", "folder": "General", "setting": "UserInterfaceLanguage",
                  "value": "de-DE", "value_type": "culture" })
```

**期望**：list 列出 `General` 与其中的设置及 `writeable` 标记；set 给出 `before/after`，
TIA 的"设置 → 常规 → 在项目中搜索"跟着变。
`setting: "NoSuchSetting"` → `setting_not_found` 且 `details.availableSettings` 有值。

⚠️ `UserInterfaceLanguage` 会改 TIA 界面语言，验证后改回来。

☐ 2.11 list 完整 ☐ 2.12 bool 设置可写 ☐ 2.13 culture 设置按 `value_type=culture` 写成功 ☐ 2.14 未知设置报错

### 2.5 `project_texts`（xlsx 导出/导入）—— 高风险，先备份工程

```jsonc
project_texts({ "action": "export", "file": "D:\\Verify\\texts.xlsx",
                "source_language": "en-US", "target_language": "de-DE" })
project_texts({ "action": "import", "file": "D:\\Verify\\texts.xlsx" })              // 直接写入：导入不包事务，无法回滚
```

**期望**：导出生成非空 xlsx（`bytes`>0、`sha256` 有值），Excel 打开能看到工程文本；
导入回报 `state`（`Info`/`Warning`/`Error`）与 `resultPath`，工程文本按文件内容更新。

⚠️ **这是本轮最不确定的一项**：`ImportProjectTexts` 的返回对象 `ProjectTextResult` 在 V17 只暴露
`State` 与 `Path`（`Path` 的语义未在手册里说明，可能是结果日志）。若 `state=Error`，把原始
`resultPath` 指向的文件内容抄进验证记录。导入失败时确认工程是否被改坏 → 用工程副本重来。

⚠️ **导入刻意不包事务**：手册 "Transaction handling → Restrictions" 明确列出 `ProjectText Import`
与 `ProjectText Export` 在事务内会抛**可恢复异常**。所以 `project_texts` 的 `data` 里没有
`committed` 字段，一致性由 `state` 与 TIA 自身保证。验证时**顺便确认这一点**：如果导入成功，
说明"不包事务"是对的；如果反而报出与事务无关的错，把原文记下来。
（另外一个可选实验，见 §5 第 15 条：临时把导入包回事务，看是否真的抛异常 —— 只在工程副本上做。）

☐ 2.15 导出文件可读 ☐ 2.16 导入的 `state` 与结果文件内容可解释 ☐ 2.17 导入后 TIA 里文本确实变了

### 2.6 `save_project`（Save 与 SaveAs）

```jsonc
save_project({})                                    // 保存当前工程
save_project({ "save_as_dir": "D:\\Verify\\tia" })  // 目标目录名与工程名不必相同
```

**期望**：保存后 `isModified:false`；SaveAs 后 `projectPath` / `savedAs` 指向新位置，
`requestedSaveAsDir` 回显你给的目录，`locationChanged` 为 true。
**注意**：SaveAs 会**改变控制器的持久化位置**（手册：Archive 不改、SaveAs 会改），
所以之后的 `save_project({})` 与 `close_project(save=true)` 都写新位置，源目录不再是控制器持有的工程。

**要确认的 SaveAs 落盘语义**（代码里没有任何校验，落点全靠 TIA 决定）：

1. 传 `save_as_dir = D:\Verify\tia` 而工程名是 `PEI_SinoARP_SWT2` 这类 → 看 `savedAs` 究竟是哪一种：
   - `D:\Verify\tia\PEI_SinoARP_SWT2\PEI_SinoARP_SWT2.ap17`（目标目录是容器，里面再建同名工程文件夹）
   - `D:\Verify\tia\PEI_SinoARP_SWT2.ap17`（目标目录就是工程文件夹本体）
   - `D:\Verify\tia\tia.ap17`（用目录名当新工程名 —— 手册 "with a different name" 的读法）
   把实际结果与 `Project.Name`（预期保持原名）一起记下来：**这正是手册没写清的那条**，也是用户实测遇到的现象。
2. 传一个**已存在且非空**的目录 → 预期 `project_save_failed`，记录 TIA 原文。
3. 传一个不存在的多层目录（`D:\Verify\a\b\c`）→ 确认自动创建还是报错。
4. `save_as_dir` 指向**源目录的父目录**（工程在 `...\V17\PEI\`，你传 `...\V17`）→ 确认 TIA 是否拒绝自我覆盖。
5. SaveAs 之后紧接着 `close_project({ "save": true, "dry_run": false })` → 确认真的写在**新**位置，
   且源目录的 `.ap17` 修改时间未变。
6. `save_project` 之后立刻 `project_info` → 确认 `attributes.path` 与 `savedAs` 一致。

**预期不该发生**：任何"目录名与工程名不一致"被**插件**拒绝的情形 ——
`OperationsProject.cs` 的 `SaveProjectAs` 把目录原样交给 `Project.SaveAs`，没有任何名字校验。

☐ 2.18 Save 生效（`isModified` 变 false） ☐ 2.19 SaveAs 后 `projectPath`/`savedAs` 与实际一致
☐ 2.19b `requestedSaveAsDir` 与 `savedAs` 的差异已记录（TIA 的落盘规则） ☐ 2.19c `locationChanged=true`
☐ 2.19d SaveAs 后 `close(save=true)` 写在新位置、源目录未被改动

### 2.7 `close_project` 之后：`create_project`

```jsonc
close_project({ "save": true, "dry_run": false })
create_project({ "project_dir": "D:\\Verify\\NewProj", "project_name": "V02Smoke",
                 "author": "dsh-tia", "comment": "created by v0.2 verification" })
```

**期望**：`D:\Verify\NewProj\V02Smoke\V02Smoke.ap17` 被创建，`projectPath` 指向它，
TIA（headless）里能看到空工程；`author`/`comment` 在"项目属性"里可见（走的是
`IEngineeringComposition.Create(Type, parameters)` 重载，**这是需要确认的路径**）。
再加一条：`create_project` 到一个**已存在且非空**的目标目录 → `project_create_failed`。

☐ 2.20 工程被创建且能列出 0 个块 ☐ 2.21 Author/Comment 真的写进去了 ☐ 2.22 非空目录被拒绝

### 2.8 `archive_project` 的 archive 与 retrieve

```jsonc
archive_project({ "target_dir": "D:\\Verify\\Archive", "target_name": "V02Smoke.zap17" })
archive_project({ "target_dir": "D:\\Verify\\Archive", "target_name": "V02Smoke.zap17",
                  "mode": "discard_restorable_data_and_compressed" })
close_project({ "save": false, "dry_run": false })
archive_project({ "action": "retrieve", "archive_path": "D:\\Verify\\Archive\\V02Smoke.zap17",
                  "target_dir": "D:\\Verify\\Retrieved" })
```

**期望**：归档生成文件、`archivedPath` 正确；未保存改动时先报 `project_not_saved`；
取回后工程打开、`projectPath` 指向 `D:\Verify\Retrieved\...`。
`mode: "none"`（不压缩）归档后再 retrieve → 手册说这种归档**不能**被 retrieve（限制 R11），
确认报的是 `retrieve_failed` 而不是崩溃。

☐ 2.23 压缩归档可被取回 ☐ 2.24 未保存先报 `project_not_saved` ☐ 2.24b 非压缩归档取回按 R11 失败
☐ 2.25 取回后工程可继续读块

---

## 3. PLC 设备数据（`OperationsPlc.cs`）

**全部在工程副本上做**；顺序按"先读 → 再写 → 最后删"。

### 3.1 `list_plc_objects`（只读，全参数一次跑通）

```jsonc
list_plc_objects({ "categories": ["blocks","types","tag_tables","external_sources","watch_tables","force_tables","units"],
                   "include_tags": true, "include_constants": true,
                   "include_attributes": true, "include_fingerprints": true, "max_items": 20 })
```

**期望**
- `blocks[].attributes[]` 每项 `{name, accessMode, value}`；`accessMode` 至少出现 `Read`/`ReadWrite`。
- `types[]` 与 `export_blocks(categories:["types"])` 的数量一致。
- `tagTables[].tags[]` 有 `name/dataType/logicalAddress/comment/external*`；
  `userConstants[]` 与 `systemConstants[]` 分开。
- **`tagTables[].modifiedTimeStamp` 有值** —— 这是对旧结论的更正（V17 暴露 `ModifiedTimeStamp`，
  不是 `ModifiedDate`）；若为空说明该属性在这个 CPU 类型上不可读，要把矩阵该条改回"未适配"。
- `blocks[].fingerprints[]` 有 `{id, value}`（`Code`/`Interface`/`Properties`/`Comments` 等）；
  若某块报 `{error: "…"}`，说明该块不一致（手册：不一致时抛可恢复异常），记录原始消息。
- `watchTables[]`/`forceTables[]` 的 `entryCount` 与 TIA 里的表行数一致。
- `units.available:false` + `reason`（没有软件单元工程的预期结果）。
- `truncated:true` 出现在 `max_items:20` 且对象更多时。

☐ 3.1 七类对象都能列出 ☐ 3.2 属性表非空 ☐ 3.3 指纹非空（或错误可解释）
☐ 3.4 `modifiedTimeStamp` 有值 ☐ 3.5 `truncated` 语义正确

### 3.1b `list_plc_objects` 的离线指纹读取（本次重点）

这是手册 **Changing blocks using fingerprints** 那一条：`FingerprintProvider` 是**离线**接口，
只要工程打开就能读，**不需要 PLC 在线**。它与另一条 `FingerprintDataProvider`（"Accessing fingerprint
for quick station compare"，需要 PN/IE 接口 + 设备 IP 的快速站比较）是**两套不同的 API**，后者未适配。

```jsonc
// 1) 具名取指纹（推荐用法：变更检测按块问）
list_plc_objects({ "block_names": ["FB_Motor", "FC_1"], "include_fingerprints": true })
// 2) 连带 UDT
list_plc_objects({ "type_names": ["MyUDT"], "include_fingerprints": true })
// 3) 全量快照（注意 max_items 默认 200）
list_plc_objects({ "categories": ["blocks","types"], "include_fingerprints": true, "max_items": 2000 })
// 4) 负例：名字不存在
list_plc_objects({ "block_names": ["NoSuchBlock"], "include_fingerprints": true })
```

**期望**
- 每个块返回 `blocks[].fingerprints: [{id, value}]`，`id` 取自
  `Code` / `Comments` / `Interface` / `LibraryType` / `Texts` / `Alarms` / `Supervisions` /
  `TechnologyObject` / `Events` / `TextualInterface` / `Properties`。**通常不会全部出现**：
  `Texts` 只有 GRAPH 块有、`Events` 只有 OB 有、`TechnologyObject` 只有工艺对象 DB 有 ——
  记录**实际出现的子集**，这是判断"哪些改动可被检测到"的依据。
- `value` 是不透明字符串（十六进制）。**先确认同一状态重复调用得到相同 value**，否则指纹不能用于比对。
- 改一个块（例如改一行代码），重新取指纹 → `Code` 的 value 变化，而**没改的块 value 不变**。
  这是本轮唯一能证明"指纹真能用于变更检测"的实验。建议一次只改一个块，并同时记录
  `Code`/`Interface`/`Comments`/`Properties` 四个常用 id 的变化，逐个确认"改动类型 ↔ id"的对应关系。
- 具名查询命中多个同名块（不同用户组重名）时全部返回；`missing` 只列**完全没匹配到**的名字。
- 负例 4 → `ok:true`（**不是**错误），`missing: { blocks: ["NoSuchBlock"] }`，`counts.blocks = 0`。
- **标签表没有指纹**：`tagTables[].fingerprints` 不应出现（手册明示 FingerprintProvider 不支持标签表）。
- 不一致的块（`isConsistent:false`）→ 该项 `fingerprints` 变成 `[{error: "…"}]`，
  **整批调用仍然 `ok:true`**，其它块照常返回；把原文错误消息记下来。

**要确认的 API 行为**
- `include_fingerprints` 的性能（手册说每次 `GetFingerprints` 都**重新计算**）：对 1000+ 块的工程做
  全量快照时记录耗时，决定是否要在工具描述里加性能提示。
- `Properties` 指纹是否随 `set_block_attributes`（如改 `Priority`）变化 —— 顺手验证"属性改动可被检测到"。

☐ 3.1b.1 具名取指纹可用，返回 `{id, value}` ☐ 3.1b.2 重复调用 value 稳定
☐ 3.1b.3 改一个块 → 只有该块对应 id 变化 ☐ 3.1b.4 实际出现的 id 子集已记录
☐ 3.1b.5 不存在的名字进 `missing` 而不报错 ☐ 3.1b.6 标签表无指纹
☐ 3.1b.7 不一致块逐块报 `error` 且不中断 ☐ 3.1b.8 全量快照耗时已记录

### 3.2 `create_plc_objects`（7 种 kind）

逐个跑：

```jsonc
create_plc_objects({ "kind": "block_group", "group_path": "V02/Sub" })                  // create_parents 默认 false
create_plc_objects({ "kind": "type_group",  "group_path": "V02Types" })
create_plc_objects({ "kind": "tag_table_group", "group_path": "V02Tags" })
create_plc_objects({ "kind": "tag_table", "name": "V02_Tags", "group_path": "V02Tags" })
create_plc_objects({ "kind": "watch_table", "name": "V02_Watch" })
create_plc_objects({ "kind": "instance_db", "name": "V02_IDB", "instance_of": "FB_Motor" })
create_plc_objects({ "kind": "unit", "name": "V02_Unit" })                              // 需要软件单元工程
```

**期望**：`data.fullPath` 是 `组/名字`；目标在 TIA 里出现；重复创建 → `object_already_exists`；
父组不存在且 `create_parents:false` → `group_not_found`（`details.available` 有组清单）；
`instance_of` 写一个不存在的 FB → `object_create_failed` 且消息里带 TIA 原文。

☐ 3.6 block_group（含 `create_parents:true` 的多级） ☐ 3.7 type_group ☐ 3.8 tag_table_group
☐ 3.9 tag_table ☐ 3.10 watch_table ☐ 3.11 instance_db ☐ 3.12 unit（或确认降级分支）
☐ 3.13 重复创建报 `object_already_exists`

### 3.3 `write_tags`（本轮最需要细看的写操作）

```jsonc
write_tags({ "tag_table": "V02_Tags",
             "tags": [ { "name": "T_Bool", "data_type": "Bool", "logical_address": "%I0.0", "comment": "from v0.2" },
                       { "name": "T_Int",  "data_type": "Int",  "logical_address": "%IW2" },
                       { "name": "T_Keep", "data_type": "Bool" } ],
             "constants": [ { "name": "C_One", "data_type": "Int", "value": "1", "comment": "const" } ] })
```

**期望**：dry-run 列出每个 tag 的 `action`（`create`/`update`）与 `exists`；
真跑后 `tags[].action` 为 `created`，`changes[]` 给出 `attribute/before/after`；
再跑一次改 `logical_address` → `action:"updated"` 且 `changes` 只含变化的属性；
`delete_tags:["T_Keep"]` → `deletedTags:["T_Keep"]`。
**要确认的点**：
- 写 `logical_address` 时 TIA 是否接受 `%I0.0` 形式（手册示例用的是 `""`）；
  地址格式不对时把 TIA 的原文错误记下来（可能要收紧工具文档）。
- `comment` 写入是否落到**编辑语言**那一项（改了工程语言会影响这里）。
- 只读属性：`tags[].name` 不允许改名（`Name` 是 r/o，工具也不提供）。

☐ 3.14 建变量（含地址与注释） ☐ 3.15 改地址/类型/外部可见性 ☐ 3.16 注释落到正确语言
☐ 3.17 建用户常量并读到 `value` ☐ 3.18 删变量与常量

### 3.4 `set_block_attributes`（OB `Priority` 等）

```jsonc
list_plc_objects({ "categories": ["blocks"], "include_attributes": true, "max_items": 5 })  // 先找可写属性
set_block_attributes({ "names": ["Main"], "attributes": { "Priority": 14 } })                // dry_run 默认 true
set_block_attributes({ "names": ["Main"], "attributes": { "Priority": 14 }, "dry_run": false })
set_block_attributes({ "target": "type", "names": ["MyUDT"],
                       "attributes": { "Comment": "x" } })   // 预期 attribute_not_writeable 或写成功
```

**期望**：dry-run 的 `applied[].changes[]` 带 `readOnly`（`Priority` 应为 `false`）；真跑后 OB 的 `Priority` 在 TIA 里变了。
写一个只读属性（如块的 `Name`）→ `attribute_not_writeable`（**这是安全检查**，必须命中）。
`value_types` 用法：`{"Priority": "integer"}`。

☐ 3.19 OB `Priority` 写成功 ☐ 3.20 只读属性被拒（`attribute_not_writeable`） ☐ 3.21 不存在块报 `block_not_found`

### 3.5 `protect_blocks` / `unprotect`

```jsonc
protect_blocks({ "block_names": ["FB_Motor"], "action": "protect", "password": "Abcd1234" })   // dry_run 默认 true
protect_blocks({ "block_names": ["FB_Motor"], "action": "protect", "password": "Abcd1234", "dry_run": false })
protect_blocks({ "block_names": ["FB_Motor"], "action": "unprotect", "password": "Abcd1234", "dry_run": false })
```

**期望**：dry-run 的 `planned[].protectionAvailable` 为 true（选一个**未被保护**的代码块或全局 DB）；
真跑后 TIA 里块显示 know-how 保护；解保护用同一口令成功。
- 用错口令解保护 → `failed[].code:"unprotect_failed"`，消息含 "The used password was refused"。
- 对一个不可保护的块（ProDiag / 系统块 / CPU-DB）→ `failed[].code:"protection_unavailable"`，
  并在 `reason` 里带上手册列出的条件。
- 口令含控制字符 → `invalid_params` 且给出非法字符码点。

☐ 3.22 加保护成功 ☐ 3.23 解保护成功 ☐ 3.24 错口令失败可读 ☐ 3.24b 不可保护块报 `protection_unavailable`

### 3.6 `generate_source`（由块/UDT 生成源）

```jsonc
generate_source({ "output_file": "D:\\Verify\\V02_Motor.scl", "block_names": ["FB_Motor"],
                  "with_dependencies": true })
generate_source({ "output_file": "D:\\Verify\\V02_UDT.udt", "type_names": ["MyUDT"] })
```

**期望**：文件生成且是 UTF-8 文本，含 `FUNCTION_BLOCK "FB_Motor"`；`sha256`/`bytes` 有值；
WithDependencies 时文件包含被调用的块与用到的 UDT。
- 扩展名不匹配（SCL 块写成 `.udt`、UDT 写成 `.scl`）→ TIA 抛异常 → `generate_source_failed`；
  确认工具的**前置校验**（`invalid_params`）不会误拦合法组合。
- 同文件已存在且 `overwrite:false` → `file_exists`。

☐ 3.25 块 → `.scl` 成功 ☐ 3.26 WithDependencies 含依赖 ☐ 3.27 UDT → `.udt` 成功
☐ 3.28 错误的扩展名被拒（工具或 TIA 任一层） ☐ 3.29 `overwrite` 语义正确

### 3.7 `watch_and_force_tables`

```jsonc
watch_and_force_tables({ "action": "create", "kind": "watch", "name": "V02_W2", "create_group": true,
                         "group_path": "V02W" })
watch_and_force_tables({ "action": "export", "name": "V02_W2", "output_file": "D:\\Verify\\V02_W2.xml" })
watch_and_force_tables({ "action": "delete", "name": "V02_W2" })
watch_and_force_tables({ "action": "import", "import_paths": ["D:\\Verify\\V02_W2.xml"] })
watch_and_force_tables({ "action": "create", "kind": "force", "name": "F1" })   // 必须报 table_create_failed
watch_and_force_tables({ "action": "delete", "kind": "force", "name": "F1" })   // 必须报 table_delete_failed
```

**期望**：监视表建/导出/删/导入闭环可用；**力表的 create 与 delete 必须报错**并在消息里说明
V17 没有对应 API（限制 R15），而不是静默失败。若实测发现力表其实能建/能删，
就把 R15 从矩阵里删掉并补上实现。

☐ 3.30 监视表建删导出导入闭环 ☐ 3.31 力表 create/delete 报 R15 口径的错误 ☐ 3.32 未知表报 `watch_table_not_found`

### 3.8 `software_units`（需要支持软件单元的工程）

```jsonc
software_units({})                                                              // action 默认 list
software_units({ "action": "create", "name": "U_V02" })
software_units({ "action": "relation_create", "name": "U_V02", "related_object": "FB_Motor",
                 "relation_type": "software_unit" })
software_units({ "action": "relation_delete", "name": "U_V02", "related_object": "FB_Motor" })
software_units({ "action": "delete", "name": "U_V02" })
```

**期望**：普通工程 → list 报 `available:false` + reason，create 报 `unit_provider_unavailable`
（**这是预期**，不要当成缺陷）；支持单元的工程 → 单元建/列/删与关系增删都生效，
`relations[]` 的 `relatedObject`/`relationType` 与 TIA 一致。

☐ 3.33 普通工程走降级分支 ☐ 3.34 支持单元的工程跑通建删与关系

### 3.9 `delete_plc_objects`（最后做）

```jsonc
delete_plc_objects({ "block_names": ["V02_IDB"], "type_names": ["V02_UDT"],
                     "tag_table_names": ["V02_Tags"], "watch_table_names": ["V02_W2"],
                     "unit_names": ["V02_Unit"], "block_group_paths": ["V02/Sub"],
                     "type_group_paths": ["V02Types"], "tag_table_group_paths": ["V02Tags"] })
delete_plc_objects({ "tag_table": "V02_Tags", "tag_names": ["T_Bool"], "constant_names": ["C_One"] })
delete_plc_objects({ "block_names": ["NoSuchBlock"] })          // 必须报 object_not_found
delete_plc_objects({ "block_names": ["NoSuchBlock"], "strict_missing": false })
```

**期望**：dry-run 的 `planned[].exists` 正确；真跑后对象消失且 `deleted[]` 与 `changes[]` 对得上；
`strict_missing:true`（默认）时不存在就整体不删并报 `object_not_found`；
删一个**非空**组 → `group_not_empty`。

☐ 3.35 各类对象删除生效 ☐ 3.36 表内变量/常量删除生效（`tag_table` 形式与 `Table.Name` 形式各测一次）
☐ 3.37 `strict_missing` 两种行为正确 ☐ 3.38 非空组报 `group_not_empty`

---

## 4. F-related Openness（`OperationsSafety.cs`）

**没有 F-CPU / 未装 STEP 7 Safety 时**只能验证降级分支；三项都要记录是"跑通"还是"降级"。

### 4.1 `safety_status`

```jsonc
safety_status({})
safety_status({ "include_runtime_groups": true, "include_settings": true })
```

**期望（有 F-CPU）**：`globalSettings.available:true` 且 `safetyModificationsPossible` 是 bool、
`usernameForFChangeHistory` 是字符串；`settings.available:true` 且
`activationOfFChangeHistory`/`safetySystemVersion`/`assignmentOfBlockNumbers.managementMode` 有值；
`administration.available:true` 且 `runtimeGroups[]` 里每个 F 运行组有 `fobName`/
`mainSafetyBlockName`/`maximumCycleTime` 等；`isSafetyOfflineProgramPasswordSet` 有值。

**期望（没有 F 能力）**：`globalSettings.available:false` + `reason`（不是错误）；
`settings`/`administration` 都是 `available:false` + `reason`。**重点确认 `GlobalSettings` 需要在
TIA Portal 上装 STEP 7 Safety 才存在** —— 这条要写进矩阵的工具提示。

⚠️ 这里会**启动一个 TIA Portal 实例**（`EnsurePortalStarted`），即使没有打开工程；
任务管理器里应能看到 `TiaPortal.exe`。

☐ 4.1 三个服务各自 available 与 reason 口径正确 ☐ 4.2 运行组字段与 TIA 一致（有 F-CPU 时）

### 4.2 `set_safety_settings`

```jsonc
set_safety_settings({ "safety_modifications_possible": false })
set_safety_settings({ "username_for_f_change_history": "v02-verify" })
set_safety_settings({ "safety_modifications_possible": true })   // 改回来
```

**期望**：直接生效并给出 `before/after/changed`；TIA 的"安全设置 → 允许修改安全程序"复选框跟着变
（手册："false 时锁定对安全程序的修改"）。
手册另有一句要确认：**没有配置口令时 `SafetyModificationsPossible(false)` 无效** —— 手工确认这一点，
并把结论写进矩阵说明。
没有 `GlobalSettings` 服务 → `global_settings_unavailable`。

☐ 4.4 真跑生效且可回退 ☐ 4.5 无口令时的行为符合手册 ☐ 4.6 缺服务时报 `global_settings_unavailable`

### 4.3 `safety_signatures`

```jsonc
safety_signatures({})                                     // 全部块
safety_signatures({ "block_names": ["FOB_SAFETY", "Main"] })
safety_signatures({ "type_names": ["MyUDT"] })
```

**期望**：F 块 `isFBlock:true` 且 `signatureType:"BlockOfflineSignature"`、`value` 是非 0 整数；
非 F 块（如 `Main`）`isFBlock:false` + `reason`（provider 为 null，手册明示）；
PLC 类型 → `isFBlock:false` + `reason`。
在 TIA 里改一下 F 程序再跑一次 → `value` 应变化（手册："最近改动导致签名失效时返回 0"，
也要确认这一情形下拿到的到底是 0 还是新值）。
`block_names` 写一个不存在的名字 → `block_not_found`。

☐ 4.7 F 块签名非 0 ☐ 4.8 非 F 块与 UDT 走"无签名"分支而不报错 ☐ 4.9 改动 F 程序后签名变化可解释

---

## 5. 需要单独确认的 API 事实（反射/手册与实现之间还剩的假设）

这些是写代码时**按手册与反射推断、但没跑过**的点；每条都要在真机上给出"是/否"并回写矩阵或注释：

| # | 事实 | 现状 | 确认方式 |
|---|---|---|---|
| 1 | `TiaPortal.GetService<GlobalSettings>()` 是否需要 STEP 7 Safety | 手册明示这个取法；未确认缺 Safety 时是返回 null 还是抛异常 | `safety_status` 在一台没装 Safety 的机器上跑 |
| 2 | `SafetySettings` 只能经 `SafetyAdministration.Settings` 取到（不是 `GetService<SafetySettings>`） | 反射实证（`SafetySettings` 不实现 `IEngineeringService`），编译期已按此实现 | 有 F-CPU 时 `safety_status` 能给出 `settings.available:true` |
| 3 | `PlcTagTable.ModifiedTimeStamp` 在 V17 可读 | 反射实证；**纠正了旧矩阵里的"V17 不可实现"结论** | 3.1 的 `modifiedTimeStamp` 有值 |
| 4 | `PlcForceTable` 无 `Delete`、`PlcForceTableComposition` 无 `Create` | 反射实证（限制 R15） | 3.7 的两个负例 |
| 5 | `ProjectComposition.Create` 的 Author/Comment 走 `IEngineeringComposition.Create(Type, params)` | 手册示例；返回 `object` 需转 `Project` | 2.7 的 Author/Comment 是否真的写进工程 |
| 6 | `Project.Archive` 要求先保存（`IsModified` 为 true 时抛 `EngineeringTargetInvocationException`） | 手册明示；实现里先自查 `IsModified` 并报 `project_not_saved` | 2.8 的顺序测试 |
| 7 | `Project.ExportProjectTexts/ImportProjectTexts` 与 `ProjectTextResult` 的语义 | 手册只有签名；`Path` 用途未知 | 2.5 |
| 8 | `WriteMultilingualText` 用**编辑语言**那一项；无该项时退回第一个非空项 | 实现选择，未实测 | 3.3 / 2.3 的注释落点 |
| 9 | `PlcUnitProvider` 在普通工程上返回 null 还是抛异常 | 实现里两种都兜住（`unit_provider_unavailable`） | 3.8 的降级分支 |
| 10 | `FingerprintProvider.GetFingerprints()` 对**不一致**块抛可恢复异常 | 手册明示；实现里逐块兜住并回报 `{error}` | 3.1b.7 |
| 11 | 同一状态下指纹 value 稳定、且只随"用户输入"变化（与编译结果无关） | 手册明示"only user input"；未实测 | 3.1b.2 / 3.1b.3 |
| 12 | `FingerprintProvider` 真的**离线**可用（不需要 PLC 在线） | 手册的 Requirement 只列"连 TIA + 工程已打开"；未实测 | 3.1b 全部（跑的时候**不要**连 PLC） |
| 13 | SaveAs 的落盘布局：目录名与工程名的对应规则 | 手册只说 SaveAs 能 "with a different name or in a different directory"，自己的例子却传了一个不同名的目录；**规则未写明**，代码里也无校验 | 2.6 的第 1 条（用户实测已碰到） |
| 14 | `Project.Name` / `Project.Path` 在 V17 只读、且没有 `SaveAs(folder, newName)` 重载 | 反射实证（`canWrite=False`，Project 只暴露 `Save()`/`SaveAs(DirectoryInfo)`） | 2.6 里"预期不该发生"那条 |
| 15 | 事务内禁止 `ProjectText Import/Export`（手册 Restrictions） | 手册明示会抛可恢复异常；实现里已按此**去掉**事务，未实测反向 | 2.5 的可选实验 |
| 16 | `project_languages` 的 `EditingLanguage` 直接赋值是否需要事务 | 手册示例直接赋值；实现未包事务 | 2.2 真跑 + 保存后重开确认持久化 |

---

## 6. 本轮有意跳过、以及卡住没做的条目

跳过的都记在覆盖矩阵里（`未适配` + 说明），这里只列**原因**，免得明天重复判断：

| 跳过项 | 原因 |
|---|---|
| 下载 / 上传 / 在线 / 比较 / 运行停止（PLC 章节约 15 条） | 前置条件 **P**：需要真实 PLC/PLCSIM 或项目服务器，离线工程上无法验证（本轮口径：跳过） |
| `Starting the block editor`、`Starting the "PLC Tags" editor`、`Open the "Devices & networks" editor`、`Supporting callbacks` | 前置条件 **D**：依赖桌面交互，headless 下语义不同 |
| `Deleting project graphics` | 需要 `Siemens.Engineering.Hmi.Globalization`（HMI 命名空间），会把 HMI 侧 API 拉进来；且不可逆。**卡住 → 跳过** |
| `Accessing read-only TIA Portal project` | 需要 UMAC 只读凭据/保护工程，本机没有受保护工程可测 |
| OPC UA、安全密码/保护级别、证书、Web 服务器、软件校验和 | 属"PLC service / Security"面，与本次三个章节的目标能力无关；`PlcChecksumProvider` 已确认可用但未暴露 |
| `Publishing software unit object`、`Units as mastercopies`、`Adding external sources in units` | 软件单元的发布/主副本依赖库与发布工作流，本轮只做单元与关系 |
| `ForceTable` 的创建与删除 | **API 不存在**（R15），不是没做 |
| `project_texts` 的"多语言文本单独导出" | 手册明示不可能（限制 R4） |
| HMI 侧的导入导出（另一个章节） | 不在本次三个分类内 |

---

## 7. 出问题时怎么定位

1. `controller_status({ "include_controller_output": true })` —— 控制器是否活着、Openness 是否可用、
   用户组是否为 true、最后一次错误码。
2. 报错帧里的 `error.code` + `error.details.hint`（`openness_unavailable` / `access denied` /
   licens 类的提示已内置）。
3. 写操作失败但 `data` 仍返回 → 说明**写入发生了但校验/后续步骤失败**，看 `data.committed`、
   `data.verification`、`data.deleted`。
4. 超时（`controller_timeout`）→ 控制器被终止、**TIA Portal 会话丢失**，下次调用会自动重启；
   归档/取回/编译这类慢操作先把 `requestTimeoutMs` 调大。
5. 事务类失败（`transaction_failed`）→ 有另一个 Openness 客户端（例如 TIA 里手动开着同一工程）。

跑完后请：
- 把每条的结论（通过/失败/降级 + 原始错误消息）回填到 [`verification.md`](verification.md)；
- 更新 `README.md` §0 的验证状态行；
- 若发现实现与手册不符，改代码并 `npm run matrix:build`（矩阵会重新生成并校验）。
