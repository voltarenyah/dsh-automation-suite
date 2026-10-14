# 扩展接口契约（v0.2 计划）

本文件是**本次扩展的冻结契约**：控制器（`controller/*.cs`）与 DSH 工具（`src/tools.ts`）
两侧都按它实现，参数名、枚举值、`data` 字段名必须逐字一致。它同时是
[`docs/coverage-matrix.html`](coverage-matrix.html) 在三个新章节上"已适配/部分"的依据。

覆盖的三个手册章节：

| 手册章节 | 本文件中的操作 |
|---|---|
| TIA Portal Openness API → Functions for projects and project data | `CreateProject` `SaveProject` `ArchiveProject` `ProjectInfo` `ProjectLanguages` `ProjectTexts` `UpdateProject` `PortalSettings` |
| TIA Portal Openness API → Functions for accessing the data of a PLC device | `ListPlcObjects` `CreatePlcObjects` `DeletePlcObjects` `WriteTags` `SetBlockAttributes` `ProtectBlocks` `GenerateSource` `WatchAndForceTables` `SoftwareUnits` |
| TIA Portal Openness API → F-related Openness | `SafetyStatus` `SetSafetySettings` `SafetySignatures` |

原本的五个操作（`OpenProject` `ExportBlocks` `ImportBlocks` `CompilePlc` `CloseProject`）
不变。加上 `controller_status`（插件侧回答，不经过控制器），工具总数为 26。

通用约定（与既有五个操作一致）：

- 每个操作返回同一个信封：`ok` / `operation` / `dryRun` / `summary` / `data` / `changes` /
  `diagnostics` / `error` / `durationMs`。`data.dryRun` 会被提升为帧级 `dryRun`。
- **写入类操作默认 `dry_run: true`**；只写文件系统而不改项目的操作（`ArchiveProject` 的
  archive、`ProjectTexts` 的 export、`GenerateSource` 的落盘）默认 `false`。
- 时间戳一律 UTC（控制器 `JsonWriter` 已统一）。
- 密码类参数只以 `SecureString` 传给 Openness，**永不回显**，`data` 里只说"已提供"。

---

## 1. CreateProject / `create_project`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `project_dir` | string（必填） | — | 存放新项目文件夹的目录 |
| `project_name` | string（必填） | — | 项目名，同时是文件夹名 |
| `author` | string | — | 可选创建参数 |
| `comment` | string | — | 可选创建参数 |
| `with_window` | boolean | false | true 则用带界面的 TIA Portal |
| `dry_run` | boolean | **false** | true 只报告将要创建的路径 |

`data`：`{ projectName, projectPath, projectDir, targetPath, created, author?, comment?, withUserInterface, plcSoftware, blockSummary, dryRun }`
dry-run 时没有 `created`/`plcSoftware`，而有 `targetPath` 与 `wouldWrite: true`。
错误码：`project_already_open` `project_create_failed` `invalid_params`。

## 2. SaveProject / `save_project`

| 参数 | 类型 | 默认 |
|---|---|---|
| `save_as_dir` | string | — |
| `dry_run` | boolean | **false** |

`data`：`{ projectName, projectPath, saved, requestedSaveAsDir?, savedAs?, locationChanged?, isModifiedBeforeSave, isModified, dryRun }`
dry-run：`{ projectName, projectPath, isModified, saveAs, saveAsDir?, wouldWrite: true, dryRun: true }`
错误码：`project_not_open` `project_save_failed`。

**关于 `save_as_dir` 的两条硬事实**（都不是本插件的限制，而是 Openness / TIA 的语义）：

1. **SaveAs 会搬迁"当前打开工程"的持久化位置**。手册 "Archiving and Retrieving a project"：
   "the Archive will not change the persistence location to the new Archived folder whereas
   **SaveAs does that**"；库的 SaveAs 一节写得更直白："The persistence of the library is changed
   after SaveAs operation"。所以 SaveAs 之后 `close_project(save=true)` 写的是**新**位置，源目录里的
   文件仍在但已不是控制器持有的那个工程。
2. **Openness 无法给工程改名**。`Project.Name` / `Project.Path` 都是只读（V17 反射实证
   `canWrite=False`），落盘方法只有 `Save()` 与 `SaveAs(DirectoryInfo)` —— **没有**
   `SaveAs(folder, newName)` 重载。即 SaveAs 只接受一个"目标目录"，目录之下怎么组织
   （项目文件夹名、`.ap17` 文件名）由 TIA 决定，工程名保持原样。手册 "Saving a project" 声称
   SaveAs 能 "save a project with a different name **or** in a different directory"，但它自己的例子
   传的是 `...\SampleProjectSaveAs` 而工程叫 `SampleProject` —— **手册从未说明目录名与工程名的
   对应规则**，也没有任何地方写"目录名必须等于工程名"。
   既然两边都无法从代码层面强制或放宽，插件就把 TIA **实际**产生的位置报回来
   （`requestedSaveAsDir` 对比 `savedAs` / `projectPath` / `locationChanged`），而不是让调用方猜。

**不得放进事务**：手册 "Transaction handling → Restrictions" 列出的事务内调用会抛可恢复异常的
动作是：`Compile`、Go Online、Go Offline、**`ProjectText Import`**、**`ProjectText Export`**、
Open/Close Global Library、**`Project Create`**、**`Project Open`**、**`Project OpenWithUpgrade`**、
**`Project Save`**、**`Project SaveAs`**、**`Project Close`**。
因此 `compile_plc`、`create_project`、`save_project`、`close_project`、`archive_project`、
`project_texts` 一律**不包事务**；其余写操作照常包（见 `OpennessHost.BeginTransaction` 的注释与
`docs/VERIFICATION-PLAN.md` §2.5/§2.6 的验证项）。

## 3. ArchiveProject / `archive_project`

`action` = `archive` | `retrieve`（默认 `archive`）。

archive 参数：`target_dir`（必填）、`target_name`（必填）、
`mode` = `none` | `compressed` | `discard_restorable_data` | `discard_restorable_data_and_compressed`（默认 `compressed`）、
`dry_run`（默认 **false**）。
`data`：`{ action:'archive', projectName, projectPath, targetDir, targetName, mode, archivedPath, isModifiedBeforeArchive, dryRun }`
错误码：`project_not_open` `project_not_saved`（项目有未保存改动）`archive_failed`。

retrieve 参数：`archive_path`（必填）、`target_dir`（必填）、`upgrade`（boolean，默认 false）、
`project_open_mode` = `primary` | `secondary`（默认 `primary`）、`with_window`（默认 false）、
`dry_run`（默认 **false**）。
`data`：`{ action:'retrieve', archivePath, targetDir, upgraded, projectOpenMode, projectName, projectPath, plcSoftware, blockSummary, dryRun }`
错误码：`project_already_open` `archive_not_found` `retrieve_failed`。

## 4. ProjectInfo / `project_info`（只读）

| 参数 | 类型 | 默认 |
|---|---|---|
| `sections` | string[] ⊆ `attributes` `comment` `languages` `history` `products` `devices` `software` `settings` | `['attributes','comment','languages','products','software']` |
| `history_limit` | integer | 50 |
| `max_objects` | integer | 200 |
| `include_attribute_infos` | boolean | false |

`data` 只含被选中的小节键：

- `attributes`: `{ name, path, author, copyright, family, version, sizeKB, isModified, creationTime, lastModified, lastModifiedBy, isSimulationDuringBlockCompilationEnabled, attributeInfos? }`（`attributeInfos` 仅在 `include_attribute_infos` 时为 `[{name, accessMode}]`）
- `comment`: `{ languages: [{culture, text}] }`
- `languages`: 与 `ProjectLanguages` 的 list 结果同形
- `history`: `{ count, entries: [{text, dateTime}], truncated }`
- `products`: `{ count, items: [{name, version}] }`
- `devices`: 与既有 `DescribeDevices()` 同形（`deviceCount` / `devices` / `deviceGroupCount` / `deviceGroups` / `hint`），`include_attribute_infos` 时每个设备/设备项附 `attributeInfos`
- `software`: `{ count, items: [{device, software, blockCount}] }`
- `settings`: 与 `PortalSettings` 的 list 结果同形

错误码：`project_not_open`。

## 5. ProjectLanguages / `project_languages`

| 参数 | 类型 | 默认 |
|---|---|---|
| `action` | `list` \| `set` | `list` |
| `active_languages` | string[]（culture 名，如 `de-DE`） | — |
| `active_mode` | `add` \| `remove` | `add` |
| `editing_language` | string（culture 名） | — |
| `reference_language` | string（culture 名） | — |
| `dry_run` | boolean | **true** |

`data`（list）：`{ supportedCount, supportedLanguages:[{culture, name, displayName}], activeCount, activeLanguages:[...], editingLanguage, referenceLanguage, dryRun:true }`
`data`（set）：`{ added:[culture], removed:[culture], activeLanguages:[...], editingLanguage, referenceLanguage, dryRun }`
错误码：`project_not_open` `language_not_found`（`details.available` 列出支持的语言）`invalid_params`。

## 6. ProjectTexts / `project_texts`

`action` = `export` | `import`（必填）。
参数：`file`（必填）、`source_language`（culture，export 必填）、`target_language`（culture，export 必填）、
`update_source_language`（boolean，默认 false，import）、`dry_run`（export 默认 **false**，import 默认 **true**）。
`data`（export）：`{ action:'export', file, sourceLanguage, targetLanguage, bytes, sha256, dryRun:false }`
`data`（import）：`{ action:'import', file, updateSourceLanguage, state, resultPath, dryRun }`（`state` 是 `Info|Warning|Error`）
错误码：`project_not_open` `project_text_export_failed` `project_text_import_failed` `invalid_params`。

导入**不在事务内**（手册 "Transaction handling → Restrictions" 明确 `ProjectText Import` 在事务里会抛
可恢复异常），因此 `data` 里也**没有** `committed` 字段 —— 一致性由 `state` 与 TIA 自身保证。

## 7. UpdateProject / `update_project`

| 参数 | 类型 | 默认 |
|---|---|---|
| `simulation_during_block_compilation` | boolean | — |
| `comment_language` | string（culture 名） | — |
| `comment_text` | string | — |
| `dry_run` | boolean | **true** |

`data`：`{ simulationDuringBlockCompilation?: {before, after, changed}, comment?: {language, before, after, changed}, dryRun }`
至少要给一个可写项，否则 `invalid_params`。
错误码：`project_not_open` `project_update_failed` `language_not_found` `invalid_params`。

## 8. PortalSettings / `portal_settings`

| 参数 | 类型 | 默认 |
|---|---|---|
| `action` | `list` \| `set` | `list` |
| `folder` | string | `General` |
| `setting` | string | —（set 必填） |
| `value` | string \| number \| boolean | —（set 必填） |
| `value_type` | `auto` \| `string` \| `boolean` \| `integer` \| `culture` | `auto` |
| `with_window` | boolean | false |
| `dry_run` | boolean | **true** |

`data`（list）：`{ folderCount, folders:[{name, settings:[{name, valueType, value, writeable}]}] }`
`data`（set）：`{ folder, setting, valueType, before, after, changed, dryRun }`
错误码：`setting_not_found`（`details.availableFolders` / `details.availableSettings`）`setting_change_failed` `invalid_params`。

## 9. ListPlcObjects / `list_plc_objects`（只读）

| 参数 | 类型 | 默认 |
|---|---|---|
| `categories` | string[] ⊆ `blocks` `types` `tag_tables` `external_sources` `watch_tables` `force_tables` `units` | `['blocks','types','tag_tables']` |
| `device_name` / `software_name` | string | — |
| `recursive` | boolean | true |
| `name_filter` | string | —（大小写不敏感子串） |
| `block_names` / `type_names` / `tag_table_names` | string[] | —（**精确名字**，跨用户组查找；给了就自动把该族加进 `categories`） |
| `include_tags` | boolean | false |
| `include_constants` | boolean | false |
| `include_attributes` | boolean | false |
| `include_fingerprints` | boolean | false |
| `max_items` | integer | 200 |

`data`：`{ device, software, counts:{...}, truncated, missing?, blockGroups?, typeGroups?, tagTableGroups?, blocks?, types?, tagTables?, externalSources?, watchTables?, forceTables?, units? }`

- `block_names` / `type_names` / `tag_table_names` 是**离线读指纹的入口**：一次问多个具名块比
  `name_filter` 的子串匹配可靠（1200 块的工程里 `name_filter` 容易多匹配）。给了精确名字时该族
  **忽略** `name_filter` 并在整棵树里查找；**没有匹配到的名字不报错**，而是列进
  `missing: { blocks: [...], types: [...], tagTables: [...] }`（这是只读操作，不该因为一个笔误整批失败）。
- `include_fingerprints` 走 `Siemens.Engineering.SW.FingerprintProvider.GetFingerprints()`
  （手册 "Changing blocks using fingerprints"）：仅 **块（FB/FC/OB/DB）与 PLC 类型**可用，
  **标签表没有**。`fingerprints[]` 的每项是 `{id, value}`，`id` ∈ `Code` `Comments` `Interface`
  `LibraryType` `Texts` `Alarms` `Supervisions` `TechnologyObject` `Events` `TextualInterface` `Properties`；
  块不一致时该项变成 `[{error: "…"}]`（手册：不一致会抛可恢复异常）而不是整批失败。
  这是**离线**读取：只依赖已打开的工程，不需要 PLC 在线。

条目形状：

- `blocks[]`: `{name, group, programmingLanguage, number, isConsistent, isKnowHowProtected, modifiedDate, compileDate, memoryLayout, autoNumber, headerAuthor, headerName, headerVersion, attributes?, fingerprints?}`
- `types[]`: `{name, group, modifiedDate, isConsistent, isKnowHowProtected, attributes?, fingerprints?}`
- `tagTables[]`: `{name, group, isDefault, tagCount, modifiedTimeStamp, tags?, userConstants?, systemConstants?}`
  - `tags[]`: `{name, dataType, logicalAddress, comment, externalAccessible, externalVisible, externalWritable}`
  - `userConstants[]`: `{name, dataType, value, comment}`
  - `systemConstants[]`: `{name, dataType, value}`
- `externalSources[]`: `{name, group}`
- `watchTables[]` / `forceTables[]`: `{name, group, isConsistent, entryCount}`
- `units[]`: `{name, author, comment, blockCount, typeCount, tagTableCount, externalSourceCount, relations:[{relatedObject, relationType}]}`
- `attributes[]`: `{name, accessMode, value}`
- `fingerprints[]`: `{id, value}`

错误码：`project_not_open` `plc_software_not_found` `plc_software_ambiguous`。

## 10. CreatePlcObjects / `create_plc_objects`

| 参数 | 类型 | 默认 |
|---|---|---|
| `kind` | `block_group` \| `type_group` \| `tag_table_group` \| `tag_table` \| `watch_table` \| `unit` \| `instance_db`（必填） | — |
| `name` | string | —（`*_group` 之外必填） |
| `group_path` | string | —（`*_group` 为要创建的组路径；其余为父组路径） |
| `create_parents` | boolean | false |
| `instance_of` | string | —（`instance_db` 必填） |
| `auto_number` | boolean | true（`instance_db`） |
| `number` | integer | 0（`instance_db`） |
| `dry_run` | boolean | **true** |

`data`：`{ kind, name, groupPath, fullPath, created, dryRun }`
错误码：`invalid_params` `group_not_found` `group_create_failed` `object_already_exists` `object_create_failed` `unit_provider_unavailable`。

## 11. DeletePlcObjects / `delete_plc_objects`

| 参数 | 类型 | 默认 |
|---|---|---|
| `block_names` / `type_names` / `tag_table_names` / `watch_table_names` / `unit_names` | string[] | — |
| `block_group_paths` / `type_group_paths` / `tag_table_group_paths` | string[] | — |
| `group_path` | string | —（在组内查找上面这些名字时用的父组路径） |
| `tag_table` | string | —（`tag_names` / `constant_names` 所属的表） |
| `tag_names` / `constant_names` | string[] | —（给了 `tag_table` 就是表内名字，否则是 `Table.Name`） |
| `strict_missing` | boolean | true |
| `dry_run` | boolean | **true** |

`data`：`{ planned:[{kind, name, group, exists}], deleted:[{kind, name, group}], missing:[string], counts:{...}, dryRun }`
错误码：`object_not_found`（`details.missing` / `details.available`）`delete_failed` `group_not_empty` `project_not_open`。

## 12. WriteTags / `write_tags`

| 参数 | 类型 | 默认 |
|---|---|---|
| `tag_table` | string（必填） | — |
| `group_path` | string | — |
| `tags` | object[]，每项 `{name, data_type?, logical_address?, comment?, external_accessible?, external_visible?, external_writable?, create?, update?}` | — |
| `constants` | object[]，每项 `{name, data_type?, value?, comment?, create?, update?}` | — |
| `delete_tags` / `delete_constants` | string[] | — |
| `dry_run` | boolean | **true** |

`data`：`{ tagTable, groupPath, tags:[{name, action, changes:[{attribute, before, after}]}], constants:[...], deletedTags:[name], deletedConstants:[name], dryRun }`
`action` ∈ `created` | `updated` | `unchanged` | `skipped` | `deleted`。
dry-run 时的 `tags` / `constants` 是计划而不是结果：每项只有 `{name, action, exists}`，其中
`action` 是 `create` 或 `update`（尚未发生，所以不是过去式）；`deleteTags` / `deleteConstants`
原样回显要删的名字。
错误码：`tag_table_not_found` `tag_not_found` `tag_create_failed` `tag_update_failed` `constant_create_failed` `constant_update_failed` `invalid_params`。

## 13. SetBlockAttributes / `set_block_attributes`

| 参数 | 类型 | 默认 |
|---|---|---|
| `target` | `block` \| `type` | `block` |
| `names` | string[]（必填） | — |
| `group_path` | string | —（省略则递归查找） |
| `attributes` | object（必填，属性名→值） | — |
| `value_types` | object（属性名→`auto`\|`string`\|`boolean`\|`integer`） | — |
| `dry_run` | boolean | **true** |

`data`：`{ target, attributes, applied:[{name, group, changes:[{attribute, before, after, readOnly}]}], dryRun }`

`readOnly` 只在 `GetAttributeInfos` **确实列出该属性且访问模式没有 Write 位**时为 `true`；
属性未被 info 列表列出时是 `false` —— 手册自己的示例 `SetAttribute("Priority", 14)` 就属于
"可写但未必出现在 info 列表里"的情形，因此"不知道"不能当成"只读"。真跑时只有
`readOnly:true` 会被前置拒绝（`attribute_not_writeable`），其余交给 Openness 判定。
错误码：`block_not_found` `type_not_found` `attribute_not_writeable` `attribute_write_failed` `invalid_params`。

## 14. ProtectBlocks / `protect_blocks`

| 参数 | 类型 | 默认 |
|---|---|---|
| `block_names` | string[]（必填） | — |
| `action` | `protect` \| `unprotect`（必填） | — |
| `password` | string（必填） | — |
| `group_path` | string | — |
| `dry_run` | boolean | **true** |

`data`：`{ action, protected:[{name, group}], failed:[{name, code, message}], counts:{protected, failed}, dryRun }`
错误码：`block_not_found` `protection_unavailable`（`GetService` 返回 null）`protect_failed` `unprotect_failed` `invalid_params`。

## 15. GenerateSource / `generate_source`

| 参数 | 类型 | 默认 |
|---|---|---|
| `output_file` | string（必填） | — |
| `block_names` | string[] | — |
| `type_names` | string[] | —（要求扩展名 `.udt`） |
| `with_dependencies` | boolean | false |
| `overwrite` | boolean | false |
| `dry_run` | boolean | **false** |

扩展名规则（手册 "Generate source from block"）：SCL 块 `.scl`，STL 块 `.awl`，DB `.db`，UDT `.udt`。
`data`：`{ outputFile, extension, withDependencies, blockCount, typeCount, bytes, sha256, dryRun }`
错误码：`invalid_params` `object_not_found` `file_exists` `generate_source_failed`。

## 16. WatchAndForceTables / `watch_and_force_tables`

| 参数 | 类型 | 默认 |
|---|---|---|
| `action` | `create` \| `delete` \| `export` \| `import`（必填） | — |
| `kind` | `watch` \| `force` | `watch` |
| `group_path` | string | — |
| `name` | string | —（create/delete/export 必填） |
| `output_file` | string | —（export 必填） |
| `import_paths` | string[] | —（import 必填） |
| `import_options` | `none` \| `override` | `none` |
| `create_group` | boolean | false |
| `overwrite` | boolean | false |
| `dry_run` | boolean | **true** |

`data`：create → `{action, kind, name, group, created, dryRun}`；
delete → `{action, kind, name, group, deleted, dryRun}`；
export → `{action, kind, name, group, file, bytes, sha256, dryRun}`；
import → `{action, imported:[{file, name}], committed, dryRun}`
错误码：`watch_table_not_found` `force_table_not_found` `table_create_failed` `table_delete_failed` `export_failed` `import_failed` `invalid_params`。

## 17. SoftwareUnits / `software_units`

| 参数 | 类型 | 默认 |
|---|---|---|
| `action` | `list` \| `create` \| `delete` \| `relation_create` \| `relation_delete` | `list` |
| `name` | string | —（create/delete/relation_* 必填） |
| `related_object` | string | —（relation_create 必填） |
| `relation_type` | `software_unit` \| `non_unit_db` \| `to_db` | `software_unit` |
| `dry_run` | boolean | **true** |

`data`：list → `{ available, unitCount, units:[{name, author, comment, blockCount, typeCount, tagTableCount, externalSourceCount, relations:[{relatedObject, relationType}]}] }`；
其余 → `{ action, name, relatedObject?, relationType?, created?, deleted?, dryRun }`
错误码：`unit_provider_unavailable`（软件未启用软件单元）`unit_not_found` `unit_exists` `unit_create_failed` `unit_delete_failed` `relation_create_failed` `invalid_params`。

## 18. SafetyStatus / `safety_status`（只读）

| 参数 | 类型 | 默认 |
|---|---|---|
| `include_runtime_groups` | boolean | true |
| `include_settings` | boolean | true |
| `with_window` | boolean | false |

`data`：
```
{
  globalSettings: { available, safetyModificationsPossible, usernameForFChangeHistory, reason? },
  settings: { available, activationOfFChangeHistory, safetyModeCanBeDisabled,
              createDriverInstanceDataBlocksWithoutPrefix, safetySystemVersion,
              applicableSafetySystemVersions?, assignmentOfBlockNumbers:{managementMode, fromFB, toFB, fromFC, toFC, fromDB, toDB}, reason? },
  administration: { available, isLoggedOnToSafetyOfflineProgram, isSafetyOfflineProgramPasswordSet, reason? },
  runtimeGroups: [ {name, fobName, mainSafetyBlockName, preProcessingName, postProcessingName,
                    infoDbName, mainSafetyBlockIDbName, fobEventClass, maximumCycleTime, warnCycleTime} ]
}
```
**不支持 F 的 PLC 不是错误**：`available:false` + `reason`。
`GlobalSettings` 从 `TiaPortal.GetService<Siemens.Engineering.Safety.GlobalSettings>()` 取（手册 "F-related Openness"），
`SafetySettings` / `SafetyAdministration` 从 `PlcSoftware.GetService<>()` 取。
错误码：`project_not_open` `openness_unavailable`。

## 19. SetSafetySettings / `set_safety_settings`

| 参数 | 类型 | 默认 |
|---|---|---|
| `safety_modifications_possible` | boolean | — |
| `username_for_f_change_history` | string | — |
| `dry_run` | boolean | **true** |

`data`：`{ safetyModificationsPossible?: {before, after, changed}, usernameForFChangeHistory?: {before, after, changed}, dryRun }`
至少要给一个参数，否则 `invalid_params`。
错误码：`global_settings_unavailable` `safety_setting_failed` `invalid_params`。

## 20. SafetySignatures / `safety_signatures`（只读）

| 参数 | 类型 | 默认 |
|---|---|---|
| `block_names` | string[] | —（省略则全部块） |
| `type_names` | string[] | — |
| `group_path` | string | — |
| `signature_type` | `block_offline_signature` | `block_offline_signature` |

`data`：`{ device, software, signatureType, fBlockCount, nonFBlockCount, blocks:[{name, group, isFBlock, signatureType?, value?}] }`
`block.GetService<SafetySignatureProvider>()` 返回 null 即非 F 块（手册 "SafetySignatureProvider"）；
签名不存在或已失效时 `value` 为 0。
错误码：`block_not_found` `signature_read_failed` `project_not_open`。
