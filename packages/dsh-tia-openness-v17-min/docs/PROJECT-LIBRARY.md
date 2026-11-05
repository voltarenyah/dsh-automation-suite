# 项目库（Project library）工作流

本文是 `project_library` 工具的契约与工作流说明。它回答三件事：

1. TIA Portal V17 的**项目库**里到底有什么、Openness 能对它做什么；
2. 本插件补上了哪些能力、哪些能力 V17 Openness 根本不存在；
3. "读取 → 编辑 → 发布新版本 → 回到工程"的可执行步骤。

> 证据口径：API 结论来自本机 `Siemens.Engineering.dll` 17.0.0.0 反射与 V17 手册
> "Functions on libraries" 章；插件行为来自 `controller/OperationsLibrary.cs` /
> `controller/OpennessHost.Library.cs`；真实项目实测见 §7。上游 V21 的 skill 只能回答
> "Openness 能不能做"，不能当成 V17 已实测。

---

## 1. 两棵树，两种语义

`Project.ProjectLibrary` 下有两棵**互不相干**的树：

| 树 | API 根 | 有没有版本 | 典型内容 |
|---|---|---|---|
| `Types`（类型） | `ProjectLibrary.TypeFolder` | **有**：每个 `LibraryType` 有 `Versions`，版本状态 `InWork` / `Committed`（Committed 即 TIA UI 里的 "Released"） | FB / FC / OB / UDT 的版本化模板 |
| `Master copies`（主副本） | `ProjectLibrary.MasterCopyFolder` | **无**：名字就是身份，没有版本号 | 几乎任何工程对象：块、DB、UDT、标签表、SW-Unit、HMI 对象、设备…… |

两棵树的文件夹都是 `LibraryTypeUserFolder` / `MasterCopyUserFolder`，都支持建夹、改名、删除；
对象本身都支持改名与删除。**类型版本**额外支持 `Export`、`FindInstances`、`SetAsDefault`；
**主副本**额外支持从工程对象 `Create`、`CreateFrom` 复制、实例化回工程。

---

## 2. V17 Openness 的能力边界（最重要的一节）

`LibraryTypeVersion` 在 V17 的完整公开成员是：

```
Export(FileInfo, ExportOptions)
FindInstances(IInstanceSearchScope)
SetAsDefault()
Delete()
Comment / Author / Guid / IsDefault / ModifiedDate / State / TypeObject / VersionNumber
Dependencies / Dependents / MasterCopiesContainingInstances
```

**没有** `Import`、**没有** `CreateVersion`、**没有** `Release`/`Commit`。`State` 是只读属性
（`InWork`/`Committed`），"Released" 只能由 TIA Portal UI 设置。手册 "Accessing type versions"
也只列了枚举、读属性、创建实例、查依赖，没有创建/发布版本。

因此：

| 需求 | V17 Openness | 本插件 |
|---|---|---|
| 列出类型/版本/主副本、文件夹 | ✅ | ✅ `action=browse` |
| 读某个类型版本的 XML | ✅ `LibraryTypeVersion.Export` | ✅ `action=read kind=type_version` |
| 读某个主副本的内容 XML | ⚠️ 只能先实例化再导出目标对象 | ✅ `action=read kind=master_copy`（事务内实例化→导出→回滚） |
| 从工程对象创建主副本 | ✅ `MasterCopyComposition.Create` | ✅ `action=publish source=project_object` |
| 复制/改名/删除主副本、建夹 | ✅ | ✅ `action=organize` |
| 把编辑后的 XML 发布成主副本 | ✅（先导入成工程对象，再 `Create`） | ✅ `action=write` / `action=publish source=file` |
| 实例化主副本/类型版本回工程 | ✅ `CreateFrom` | ✅ `action=use operation=instantiate` |
| 更新工程里过期的类型实例 | ✅ `UpdateProject` | ✅ `action=use operation=update_project` |
| 查实例/依赖/被依赖/过期检查 | ✅ | ✅ `action=use operation=instances/dependencies/update_check` |
| **新建类型版本 / Release** | ❌ 无 API | ❌ 返回 `library_type_version_publish_unsupported` + UI 步骤 |
| **把 XML 导入成类型版本** | ❌ 无 API | ❌ 同上；替代方案是发布成主副本 |
| 全局库（`.zal`/`.zap`）打开、归档、保存 | ✅（另一套 `TiaPortal.GlobalLibraries`） | 本工具**只做项目库**；全局库未接线 |
| HMI / 硬件主副本的导出/实例化 | ✅（对象各自有 `Export`/`CreateFrom`） | 未路由；返回 `*_unsupported`，不猜目标 |

> 一句话：**"编辑并发布新版本"对主副本成立，对类型版本在 V17 只能走 TIA UI。**
> 不要向调用方承诺一个 Openness 不存在的动作。

### 2.1 "导出 → 编辑 → 导入库版本 → 发布 → 更新实例"逐段可行性

| 段 | V17 Openness | 结论 |
|---|---|---|
| 导出库版本 | `LibraryTypeVersion.Export` | ✅ |
| 编辑 XML | 离线 | ✅（本插件之外） |
| 导入成**库版本** | 无 Import | ❌ |
| 新建类型版本 | 无 CreateVersion | ❌ |
| Release/Committed | `State` 只读，无 Release | ❌（只能 TIA UI） |
| 发布成**主副本** | `MasterCopyComposition.Create` | ✅（无版本号） |
| 更新工程实例 | `ILibrary.UpdateProject` | ✅（只对已有已发布版本） |

所以完整的**类型版本**闭环不是 Openness 能独立完成的：中间三步（导入库、建版本、Release）
只能 TIA UI。Openness 能独立完成的是"导出类型版本 → 编辑 → 作为主副本发布 → 实例化"，
或者"TIA UI 建版本/Release → Openness 更新实例"。

---

## 3. 工具契约

一个工具、一个控制器操作（`ProjectLibrary`），用 `action` 选择子面：

| action | 作用 | 写工程/库 | 默认 dry-run |
|---|---|---|---|
| `browse` | 列类型/版本/主副本/文件夹/内容描述/依赖 | 否 | — |
| `read` | 导出一个类型版本或主副本到 XML | 只写文件（主副本导出在事务里回滚） | — |
| `export` | **整库导出**：所选类型版本 + 主副本写入 `<output_dir>/types/...`、`master-copies/...` 与 `_manifest.json` | 只写文件（主副本导出逐对象回滚） | — |
| `write` | 把编辑后的 XML 发布成主副本（`new`/`replace`/`new_version`） | 是 | 是 |
| `publish` | 从工程对象或 XML 创建主副本 | 是 | 是 |
| `organize` | `create_folder` / `rename` / `delete` / `copy_master_copy` / `set_default_version` | 是 | 是 |
| `use` | `instantiate` / `update_project` / `instances` / `dependencies` / `update_check` | `instantiate`/`update_project` 是 | 是（仅这两个） |

常用参数：

- 定位类型：`name` + 可选 `folder`；同名类型用 `guid`（`browse` 的 `items[].guid`）。
- 定位版本：`version` = `default`（默认版本）/ `latest` / `committed` / `1.0.0` / 版本 GUID。
- 定位主副本：`name` + 可选 `folder`（主副本重名时用 `folder` 收窄）。
- 发布模式：`mode=new`（必须不存在）、`replace`（`keep_previous=true` 把旧的改名为
  `<name>__previous_<timestamp>`，否则删除）、`new_version`（名字追加 `_v<version_label>`，
  没给 label 用时间戳）。
- 输出路径：`read` 的 `output_file` 省略时写
  `<workspace>/library/types/<name>@<version>.xml` 或 `<workspace>/library/master-copies/<name>.xml`。

---

## 4. 工作流 A0：一次性把项目库纳入受控

已有工程（例如本仓两个 workspace 里的 `PEI_HF_M4L_ZRW_Test_V5.1` 与 `PEI_SinoARP_SWT2`）的
`source/` 只包含 PLC 软件对象（blocks/types/tag tables），**不包含项目库**。补上项目库能力
不会追溯导出历史内容，需要每个工程跑一次：

```jsonc
{
  "action": "export",
  "output_dir": "<workspace>/library",   // 默认就是这里
  "include": "all",                      // all | types | master_copies
  "versions": "all",                     // all | committed | default
  "overwrite": false                     // 重跑时传 true
}
```

产物：

```
<output_dir>/
  _manifest.json                       # 工程身份、选择条件、counts、每个文件的 sha256、failures
  types/<库文件夹>/<类型名>/<版本>.xml   # 每个选中的类型版本一个文件
  master-copies/<库文件夹>/<主副本名>.xml
```

要点：

- `_manifest.json` 是**权威清单**；`data.files` 只回前 `max_files`（默认 200）条，完整列表在清单里。
- 单个对象被 TIA 拒绝（InWork 版本、不一致主副本、HMI/硬件主副本）**不会中止整批**，会进
  `failures[]`；HMI/硬件主副本按设计不可导出。
- 之后把它加入 git（`library/` 目录）就是"受控"；重跑用 `overwrite=true` 刷新。
- 现有 `source/` 的 blocks/types/tag tables 不需要因为项目库能力而重导；它们是 PLC 软件树，
  与项目库是两套对象。要重导只是为了拿最新工程状态，不是这次改动的必需步骤。

## 4. 工作流 A：浏览与读取

```jsonc
// 1) 看整棵项目库（类型 + 主副本）
{ "action": "browse" }

// 2) 只看某个文件夹，且带依赖
{ "action": "browse", "kind": "types", "folder": "999_Bibliotheque/UDT", "include_dependencies": true }

// 3) 导出某个已发布版本（InWork 版本会被 Openness 拒绝，返回 library_version_in_work）
{ "action": "read", "kind": "type_version", "name": "UDT_MotionPara", "version": "default" }

// 4) 导出主副本内容
{ "action": "read", "kind": "master_copy", "name": "Heating_Cav_A" }
```

`read` 返回 `file` / `bytes` / `sha256` / `header`。类型版本导出的 `header` 形如：

```json
{
  "element": "SW.Types.PlcStruct",
  "kind": "library_type_version",
  "simaticType": "PlcStruct",
  "name": "UDT_MotionPara",
  "number": "123",
  "libraryTypeVersion": {
    "typeName": "UDT_MotionPara",
    "typeGuid": "ba4fe287-…",
    "version": "0.0.2",
    "author": "E088134",
    "modifiedDate": "2024-12-24T07:07:48.56Z",
    "contentElement": "SW.Types.PlcStruct"
  }
}
```

**库版本 XML 有两层**：外层 `SW.Types.PlcTypeLibraryTypeVersion`（或
`SW.Blocks.CodeBlockLibraryTypeVersion`）是版本元数据，真正的内容在
`<ObjectList>` 里的 `ContentObject`（例如 `SW.Types.PlcStruct`）。本插件在发布时会自动
剥掉外层、清掉 `LibraryConformanceStatus`/`LibraryTypeGuid`/`VersionNumber` 等库元数据，
再作为普通 Simatic ML 导入。

主副本导出是在一个**独占事务里实例化 → 导出 → 不 Commit**（dispose 即回滚），
所以工程不会被留下临时对象。实测一个 `GlobalDB` 主副本因为内容不一致被 TIA 拒绝，
返回 `library_master_copy_inconsistent`——这是 Openness 的限制，不是插件猜错。

---

## 5. 工作流 B：编辑主副本并发布新版本

主副本没有版本号，"发布新版本"= **用新名字创建一份新主副本**，旧的可保留。

### B1. 从工程对象直接发布（最稳，不经过 XML）

```jsonc
// 把工程里的 FB_Motor 复制成主副本 FB_Motor_v2（mode=new_version + version_label）
{
  "action": "publish",
  "kind": "master_copy",
  "source": "project_object",
  "category": "blocks",
  "object_name": "FB_Motor",
  "object_group": "Motors",      // 可选
  "folder": "999_Bibliotheque",
  "version_label": "2",
  "dry_run": false
}
```

- 先跑 `dry_run=true` 看 `targetName` 与 `exists`；
- 目标已存在时：`mode=replace`（默认 `keep_previous=true` 保留旧副本）或换名字；
- `category` 支持 `blocks` / `types` / `tag_tables`；标签表是 `IMasterCopySource`，可以直接发布。

### B2. 从编辑后的 XML 发布（真正的"改内容"）

```jsonc
// 1) 导出（或从别处拿一份 Simatic ML）
{ "action": "read", "kind": "master_copy", "name": "FB_Motor" }

// 2) 编辑 <workspace>/library/master-copies/FB_Motor.xml

// 3) 发布成新主副本
{
  "action": "write",
  "kind": "master_copy",
  "file": "C:\\ws\\library\\master-copies\\FB_Motor.xml",
  "folder": "999_Bibliotheque",
  "mode": "new_version",
  "name": "FB_Motor",
  "version_label": "3",
  "dry_run": false
}
```

内部步骤（一个事务）：

1. 读 XML，取对象类型/名字；
2. 把 XML 的对象名改成**目标名**（目标名在工程里已被占用时才用 `dsh_lib_<8hex>` 暂存名）；
3. 导入工程（`ImportOptions.Override`）；
4. 从导入的对象 `MasterCopyComposition.Create`；
5. `replace` 时先改名/删除旧主副本；
6. 删除导入的临时对象；
7. Commit。

> 注意：**标签表不能从 XML 发布**。标签名在整个 PLC 内全局唯一，用暂存名导入仍会和已有
> 标签冲突；请用 `source=project_object` 直接发布标签表主副本。

### B3. 保留旧版本

`mode=replace` + `keep_previous=true` 会把旧主副本改名为
`<name>__previous_<yyyyMMddHHmmss>`，新副本占用原名。要显式历史链，用
`mode=new_version` 让每版一个新名字（`FB_Motor_v1`、`FB_Motor_v2`……），再用
`action=organize operation=rename` 调整。

---

## 6. 工作流 C：类型版本——读、编辑、发布（V17 限制）

### C1. 能做的部分

```jsonc
// 读
{ "action": "read", "kind": "type_version", "name": "UDT_MotionPara", "version": "committed" }

// 看依赖/被依赖/实例
{ "action": "use", "operation": "dependencies", "name": "UDT_MotionPara", "version": "0.0.2" }
{ "action": "use", "operation": "instances", "name": "UDT_MotionPara", "version": "0.0.2" }

// 设默认版本 / 删除某个已发布版本
{ "action": "organize", "operation": "set_default_version", "kind": "type_version", "name": "UDT_MotionPara", "version": "0.0.2", "dry_run": false }
{ "action": "organize", "operation": "delete", "kind": "type_version", "name": "UDT_MotionPara", "version": "0.0.1", "confirm": true, "dry_run": false }
```

### C2. 不能做的部分（不要假装能）

```jsonc
{ "action": "publish", "kind": "type_version", "source": "file", "file": "…\\UDT_MotionPara.xml", "dry_run": false }
```

返回 `library_type_version_publish_unsupported`，`details` 里有：

- `opennessVersion: "17"`；
- `reason`：V17 只有 `Export`，没有 Import/CreateVersion/Release，`State` 只读；
- `uiSteps`：在 TIA Portal 里新建版本并 Release 的步骤；
- `fallback`：改走主副本闭环。

### C3. 推荐的替代闭环（可执行、可验证）

```jsonc
// 1) 导出已发布版本
{ "action": "read", "kind": "type_version", "name": "UDT_MotionPara", "version": "default" }

// 2) 编辑 XML（版本包装层会在发布时自动剥掉）

// 3) 发布成主副本，用名字记录版本
{
  "action": "publish",
  "kind": "type_version",
  "source": "file",
  "file": "C:\\ws\\library\\types\\UDT_MotionPara@0.0.2.xml",
  "allow_master_copy_fallback": true,
  "mode": "new",
  "name": "UDT_MotionPara_v3",
  "folder": "999_Bibliotheque/UDT",
  "dry_run": false
}
```

返回值带 `fallback: true`、`supportedByOpenness: false`，并给出新主副本的内容名
（正常情况下就是 `UDT_MotionPara_v3`；如果工程里已有同名对象，会给出
`contentNameWarning`，实例化时用 `new_name` 改名）。

如果调用方坚持要"类型版本"而不是主副本，只能在 TIA Portal UI 里完成 C2 的 `uiSteps`，
然后用 `action=browse` 确认新版本的 `state` 变成 `Committed`。

---

## 7. 工作流 D：把库对象用回工程

```jsonc
// 实例化一个类型版本（块或 UDT）
{
  "action": "use",
  "operation": "instantiate",
  "kind": "type_version",
  "name": "UDT_MotionPara",
  "version": "default",
  "target_group": "MyTypes",
  "new_name": "UDT_MotionPara_Local",
  "dry_run": false
}

// 实例化一个主副本
{ "action": "use", "operation": "instantiate", "kind": "master_copy", "name": "FB_Motor_v2", "target_group": "Motors", "dry_run": false }

// 把工程里过期的类型实例更新到最新已发布版本
{ "action": "use", "operation": "update_project", "kind": "all", "dry_run": false }

// 只检查哪些实例过期（不改工程）
{ "action": "use", "operation": "update_check", "check_mode": "all" }
```

`instantiate` 在一个事务里创建对象；`new_name` 会在创建后 `SetAttribute("Name", …)`。
**注意**：`CreateFrom` 先按库对象自己的名字创建，再改名；如果这个名字在当前 PLC 里已经存在
（例如刚发布的主副本内容名与源块同名），TIA 会直接拒绝（"No changes could be made"）。
本插件从 `source=project_object` 发布块/UDT 时走"导出→按目标名导入→Create"的往返，所以
主副本内容名就是目标名，实例化时用 `new_name` 即可；如果仍遇到同名，先删/改工程里的同名对象，
或给主副本换一个目标名重新发布。标签表主副本例外（内容名=源标签表名，见 §5 B2 的说明）。

`update_project` 用 `ILibrary.UpdateProject(selections, scopes)`，`scopes` 是 PLC 软件；
它只更新**已发布**版本对应的实例。`update_check` 是只读的，返回层级化的
`messages[]`（`description` + `parts`）。

---

## 8. 真实项目实测（2026-11-04，SWT2 副本）

| 步骤 | 结果 |
|---|---|
| 打开 `PEI_SinoARP_SWT2.ap17`（437 MB，headless） | ✅ 26.4 s |
| `action=browse` | ✅ 6.4 s：**280 个类型 / 424 个版本 / 8 个主副本**；非 ASCII 文件夹（`999_Bibliotheque/Fonctions méthode`、`55_Cavité_STD`）与 3 层嵌套均正确 |
| `action=read kind=type_version` `UDT_MotionPara` | ✅ 5 619 B XML；`header` 正确识别 `SW.Types.PlcStruct` 与 `LibraryTypeVersion`（`0.0.2` / `ba4fe287-…`） |
| `action=read kind=master_copy` `Heating_Cav_A`（GlobalDB） | ⚠️ `library_master_copy_inconsistent`：TIA 报 "Inconsistent blocks and PLC data types (UDT) cannot be exported"；事务已回滚，工程未留临时对象 |
| `action=read kind=master_copy` HMI 标签表 | ⚠️ `library_master_copy_export_unsupported`（`Siemens.Engineering.Hmi.Tag.TagTable`），按设计不猜目标 |
| `action=publish kind=type_version source=file allow_master_copy_fallback=true` | ✅ 导入编辑后的 UDT 内容 → 创建主副本 `UDT_MotionPara_vTest`；`content[0].name` 与目标名一致 |
| `action=browse kind=master_copies folder=DSH_Test` | ✅ 看到新主副本及其内容描述 |
| `action=organize delete`（主副本 + 文件夹） | ✅ 清理成功 |

> 这轮实测抓到的两个真实行为：① 库版本 XML 是**包装层 + ContentObject**，直接当块 XML 导入
> 会失败，必须剥壳；② 主副本内容名 = 导入对象名，所以发布时要用目标名导入（被占用才用暂存名），
> 否则主副本里会留下 `dsh_lib_…`。两者都已修进代码。

### 8.1 整库导出实测（2026-11-05，两个真实 workspace）

对两个已有工程的 TIA 副本执行 `action=export include=all versions=all`，输出到临时目录后核对
manifest 与磁盘（导出完成后临时目录已删除）：

| 工程 | 类型 / 版本 / 主副本 | 成功文件 | 失败 | 失败构成 |
|---|---|---|---|---|
| `PEI_HF_M4L_ZRW_Test_V5.1`（SWT1） | 165 / 238 / 15 | **229** | 24 | 9 个 `InWork` 版本；7 个不一致 FC 主副本；8 个硬件 `DeviceImpl` 主副本 |
| `PEI_SinoARP_SWT2`（SWT2） | 280 / 424 / 8 | **406** | 26 | 18 个 `InWork` 版本；1 个不一致 `GlobalDB` 主副本；7 个 HMI 标签表主副本 |

- 两个工程的 manifest 都是 **0 重复路径、0 缺失文件**（同名类型/版本用 GUID 后缀区分）。
- 两个 workspace 的 `source/` 只含 PLC 软件树（SWT1 917 文件、SWT2 1379 文件），
  **没有** `library/` 目录，也没有 `LibraryTypeGuid` 标记——项目库此前完全没被导出受控。
- `InWork` 版本无法经 Openness 导出；要完整受控，先在 TIA UI 里 Release 它们，或接受这部分缺口。
- 不一致主副本（SWT1 的 7 个 FC、SWT2 的 `Heating_Cav_A`）需要先在 TIA 里修好；
  HMI/硬件主副本不在本插件的 PLC-only 路由内，若要受控需另做支持或 UI 手工导出。

### 8.2 直接导入库实例会损坏链接（2026-11-05 实测）

工程：SWT2 副本；块 `SCP_OUT`（FB 114，库版本 `2.5.1`）。用 `with_read_only` 导出后，只把
`MemoryReserve` 从 100 改成 101，保留 `LibraryType` / `LibraryTypeVersionGuid`，再用
`import_blocks` + `override` 导回原组：

| 观察点 | 结果 |
|---|---|
| `ImportBlocks` | ✅ `committed=true`，写后验证 `passed=true` |
| 导入后块属性 | ⚠️ `isConsistent=false` |
| `ProjectLibrary use operation=instances` | ❌ `count=0`，库实例链接已丢失 |
| 库版本 XML 前后对比 | 内容不变（只有 `<Created>` 时间戳不同），库没有被更新 |
| 再导出该块 | ❌ `export_failed`：`Inconsistent blocks and PLC data types (UDT) cannot be exported` |

结论：TIA UI 的 check-in / 编辑 / release 是库感知流程；`ImportBlocks` 是项目级块导入，不执行
check-in/update/release。**导入会成功，但实例脱离库、库版本不变、块变成 inconsistent，Openness
之后既不能导出也不能修复。**

因此 `import_blocks` 现在默认拒绝覆盖库实例（`library_managed_block`），只有显式
`allow_library_managed_import=true` 才放行；dry run 会给出 `libraryManaged[]`、`blocked:true`、
`ready:false`。Simatic ML 块/类型按目标名检查；SCL/STL 外部源按声明名检查（外部源可能生成多个块）。
库管控块应走 §6 的库感知流程，或先在 TIA UI 里 check-in/release。

> 注意：现有 `source/` 由 `rebuildSource` 用 `with_defaults` 导出，ReadOnly 的
> `LibraryType`/`LibraryTypeVersionGuid` **不会写进 XML**，所以 agent 从 source 里看不出库管控；
> 护栏是在导入时向 TIA 查 `LibraryTypeInstanceInfo`，不依赖 XML 元数据。

### 8.3 `library/` 与 `source/` 的工作流边界

`library/` 是新增的独立目录，现有工作流几乎都只认 `source/`：

| 工作流 | 读什么 | 库内容的影响 |
|---|---|---|
| `create_engineering_project` / `rebuildSource` | PLC 软件树 | 不导出项目库；只导出库实例的 PLC 块 |
| `ingestKnowledgeGraph` | `source/<device>/` | **只存在于库、未实例化到 PLC 的块不会被 ingest**；已实例化的块按普通块入库，库版本/历史不在图里 |
| `project_sync` / `project_diff` / `project_commit` | `source/<device>/` 与 evidence | 库版本变化**不会**出现在 diff/evidence/commit 里，除非另加 library 路径 |
| `import_preflight` | `source/` 文件 + 打开工程 | 看不到"只在 library 里"的名字；库实例的硬护栏在 `import_blocks` 导入时 |
| `project_status` / `workspace_describe` | 索引 + `source/` + knowledge | 目前不报告 `library/`；需要扩展索引/描述 |

如果要把库内容纳入同一套工作流，至少需要：把 `library/` 加进 `create_engineering_project` 的
基线提交路径、把 library 摘要写进索引/`project_status`，并决定 knowledge graph 是否要 ingest
库对象（它现在按 device 目录建库，库对象没有 device 归属）。

### 8.4 模型遇到 `library_managed_block` 时的标准动作

`import_blocks` 返回 `library_managed_block` 时，**不要重试 `allow_library_managed_import=true`**。
错误详情里已经有 `blocks[]{name, group, library{type, version, versionGuid, state}}` 和
`recommendedActions`，模型应当：

1. **先确认**：用 `project_library action=use operation=instances` 或 `action=read` 查清
   这个块链接的是哪个库类型/版本、状态是 `InWork` 还是 `Committed`；
2. **给用户两条明确的路，让用户选**：

   **路 A（推荐，库感知）**：用户在 TIA Portal 里 check-out / 编辑 / release（或新建版本），
   然后 agent 用 `project_library action=browse/read` 确认新版本，再用
   `project_library action=use operation=update_project` 更新工程实例。Openness 只做读、导出、
   更新实例，不碰库版本的创建/发布。

   **路 B（用户明确同意的 fork）**：把库管控块导出为 XML，**去掉**
   `LibraryType` / `LibraryTypeVersionGuid` / `LibraryConformanceStatus`，改一个新名字，
   作为**新的普通块**导入，然后由用户在 TIA 里把调用方改到新块。注意：
   - Openness **不会**自动重写 LAD/SCL 里的调用点；跨引用更新必须由用户/UI 完成；
   - 原库管控块还在，fork 是**单向分叉**，后续库版本更新不会流到这个新块；
   - 如果保留原名导入，仍会被 `library_managed_block` 拦住；
   - 这是"经用户确认的偏离"，不是"更新库"。

3. **只给建议、不落盘**也是合法路径：把导出的 XML、diff 和修改说明交给用户，让用户在 TIA 里
   手工改并 release；agent 只负责复核。

`library_managed_block` 的 `recommendedActions` 就是这三条，模型不需要自己发明流程。

---

## 9. 安全与事务

- 所有写（`write`/`publish`/`organize`/`instantiate`/`update_project`）都在
  `ExclusiveAccess.Transaction(project, …)` 里；最后一步成功才 `CommitOnDispose()`，
  否则 dispose 回滚。
- `read kind=master_copy` 也是事务：实例化 → 导出 → **不 Commit**，工程不落临时对象。
- 发布时先 `dry_run=true` 看 `targetName`/`exists`/`header`，再 `dry_run=false`。
- `organize operation=delete` 需要 `confirm=true` 且 `dry_run=false`；两个条件缺一不可。
- 主副本导出/实例化只路由 PLC 块、PLC 类型、PLC 标签表；HMI/硬件对象明确报不支持，
  不会创建到错误目标。

---

## 10. 错误码速查

| 错误码 | 含义 / 处理 |
|---|---|
| `project_not_open` | 先 `open_project` |
| `library_type_not_found` / `library_type_ambiguous` | 用 `guid` 或更窄的 `folder`；`details.available`/`candidates` 给候选 |
| `library_version_not_found` | `details.available` 列出该类型的版本号 |
| `library_version_in_work` | 该版本是 `InWork`，Openness 拒绝导出；用 `version=committed` 或具体版本号 |
| `library_master_copy_not_found` / `_ambiguous` / `_exists` | 定位失败/重名/目标已存在；`mode=replace` 或换名 |
| `library_master_copy_inconsistent` | 主副本内容在 TIA 里不一致；先在 TIA 修好，Openness 无法导出/实例化 |
| `library_master_copy_export_unsupported` / `_instantiate_unsupported` | HMI/硬件等未路由对象；不要猜目标 |
| `library_master_copy_xml_unsupported` | 标签表不能从 XML 发布；改用 `source=project_object` |
| `library_type_version_publish_unsupported` | V17 无类型版本发布 API；看 `details.uiSteps` / `details.fallback` |
| `confirmation_required` | 删除需要 `confirm=true` 且 `dry_run=false` |
| `library_folder_not_found` | `details.available` 列出可用文件夹 |

---

## 11. 已知边界

- **只做项目库**：全局库（`TiaPortal.GlobalLibraries` 的 `.zal`/`.zap` 打开、归档、保存、
  跨库 `UpdateLibrary`）没有接线；`browse` 的 `library` 字段固定是 `"project"`。
- **类型版本发布不存在**：见 §2/§6；这是 Openness V17 的 API 缺口，不是本插件漏做。
- **主副本无版本号**：`new_version` 只是命名约定，不产生 TIA 的版本对象；要真正的版本链，
  仍然得用 Types 树 + TIA UI。
- **HMI/硬件主副本未路由**：可以 `browse` 看到，但导出/实例化会返回 `*_unsupported`。
- **多对象主副本按第一条内容路由**：`MasterCopy.ContentDescriptions` 可能有多条（一个主副本装多个对象或一个文件夹）；
  本工具用第一条的 `ContentType` 选择导出/实例化目标，混合类型的主副本可能被 Openness 拒绝，错误按原样返回。
- **导出主副本可能因内容不一致失败**：TIA 的 `Export` 对引用了缺失 UDT 的 DB 直接拒绝；
  返回 `library_master_copy_inconsistent`，不会留下半成品。
- **一个工作区一个工程**：库操作跟当前打开工程走；换工程先 `close_project` 再 `open_project`。
