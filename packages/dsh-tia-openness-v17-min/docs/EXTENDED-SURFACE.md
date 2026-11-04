# 扩展接口契约（v0.2 计划）

本文件是**本次扩展的冻结契约**：控制器（`controller/*.cs`）与 DSH 工具（`src/tools.ts`）
两侧都按它实现，参数名、枚举值、`data` 字段名必须逐字一致。它同时是
[`docs/coverage-matrix.html`](coverage-matrix.html) 在三个新章节上"已适配/部分"的依据。

覆盖的三个手册章节：

| 手册章节 | 本文件中的操作 |
|---|---|
| TIA Portal Openness API → Functions for projects and project data | `CreateProject` `SaveProject` `ArchiveProject` `ProjectInfo` `ProjectLanguages` `ProjectTexts` `UpdateProject` `PortalSettings` |
| TIA Portal Openness API → Functions for accessing the data of a PLC device | `ListPlcObjects` `CreatePlcObjects` `DeletePlcObjects` `WriteTags` `SetBlockAttributes` `ProtectBlocks` `GenerateSource` `WatchAndForceTables` `SoftwareUnits` |
| 同上 → Blocks → "Starting the block editor" | `ShowBlocksInEditor` |
| TIA Portal Openness API → F-related Openness | `SafetyStatus` `SetSafetySettings` `SafetySignatures` |
| 版本管理取证（服务专用，无模型工具） | `PlcChecksum` `SyncScan` |

原本的五个操作（`OpenProject` `ExportBlocks` `ImportBlocks` `CompilePlc` `CloseProject`）
不变。加上 `controller_status`（插件侧回答，不经过控制器），模型面工具总数为 **38**；
操作总数为 **39**，其中 `PlcChecksum` 与 `SyncScan` 只通过 `engineeringAccess` 服务暴露。

通用约定（与既有五个操作一致）：

- 每个操作返回同一个信封：`ok` / `operation` / `dryRun` / `summary` / `data` / `changes` /
  `diagnostics` / `error` / `durationMs`。`data.dryRun` 会被提升为帧级 `dryRun`。
- **`dry_run` 只留给"预览带信息量"的操作**（决策 D22）：`OpenProject`、`ImportBlocks`、
  `CloseProject` 与 `DeletePlcObjects`、`WriteTags`、`SetBlockAttributes`、`ProtectBlocks`。
  其余操作**没有** `dry_run` —— 它们要么写的是一两个具名对象、真的调用会在写入前干净失败，
  要么预览只是把入参复述一遍。删掉 `dry_run` 的操作，`data.dryRun` 恒为 `false`。
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
| `with_window` | boolean | true | 用带界面的 TIA Portal（默认）；false 为无人值守的 headless |

`data`：`{ projectName, projectPath, projectDir, targetPath, created, author?, comment?, withUserInterface, plcSoftware, blockSummary, dryRun }`
错误码：`project_already_open` `project_create_failed` `invalid_params`。

## 2. SaveProject / `save_project`

| 参数 | 类型 | 默认 |
|---|---|---|
| `save_as_dir` | string | — |

`data`：`{ projectName, projectPath, saved, requestedSaveAsDir?, savedAs?, locationChanged?, isModifiedBeforeSave, isModified, dryRun }`
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
`mode` = `none` | `compressed` | `discard_restorable_data` | `discard_restorable_data_and_compressed`（默认 `compressed`）。
`data`：`{ action:'archive', projectName, projectPath, targetDir, targetName, mode, archivedPath, isModifiedBeforeArchive, dryRun }`
错误码：`project_not_open` `project_not_saved`（项目有未保存改动）`archive_failed`。

retrieve 参数：`archive_path`（必填）、`target_dir`（必填）、`upgrade`（boolean，默认 false）、
`project_open_mode` = `primary` | `secondary`（默认 `primary`）、`with_window`（默认 true；headless 需显式 false）。
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

`data`（list）：`{ supportedCount, supportedLanguages:[{culture, name, displayName}], activeCount, activeLanguages:[...], editingLanguage, referenceLanguage, dryRun:false }`
`data`（set）：`{ added:[culture], removed:[culture], activeLanguages:[...], editingLanguage, referenceLanguage, dryRun:false }`
错误码：`project_not_open` `language_not_found`（`details.available` 列出支持的语言）`invalid_params`。

## 6. ProjectTexts / `project_texts`

`action` = `export` | `import`（必填）。
参数：`file`（必填）、`source_language`（culture，export 必填）、`target_language`（culture，export 必填）、
`update_source_language`（boolean，默认 false，import）。
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
| `with_window` | boolean | true |

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

`data`：list → `{ available, unitCount, units:[{name, author, comment, blockCount, typeCount, tagTableCount, externalSourceCount, relations:[{relatedObject, relationType}]}] }`；
其余 → `{ action, name, relatedObject?, relationType?, created?, deleted?, dryRun }`
错误码：`unit_provider_unavailable`（软件未启用软件单元）`unit_not_found` `unit_exists` `unit_create_failed` `unit_delete_failed` `relation_create_failed` `invalid_params`。

## 18. SafetyStatus / `safety_status`（只读）

| 参数 | 类型 | 默认 |
|---|---|---|
| `include_runtime_groups` | boolean | true |
| `include_settings` | boolean | true |
| `with_window` | boolean | true |

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

## 21. PlcChecksum（服务专用，只读）

读一个 PLC 软件编译后的校验和。V17 的实际属性名是 `PlcChecksumProvider.Software`
（不是新手册里的 `Checksum`），空字符串表示"还没编译过，或改动后还没再编译"。

| 参数 | 类型 | 默认 |
|---|---|---|
| `device_name` / `software_name` | string | 自动（工程里唯一的 PLC） |

`data`：`{ device, software, checksum }`。
空值以 `checksum_unavailable` 失败（这是**状态**，不是传输错误）；服务面
`readPlcChecksum()` 把它原样作为 `ok:false` 返回，调用方据此提示"先编译"。

## 22. SyncScan（服务专用，只写文件）

用上一版 evidence 账本与当前工程逐对象比对，只把差异导出到 `stage_dir`，
并在那里写下一版 `_evidence.json`。**不修改工程**。

| 参数 | 类型 | 默认 |
|---|---|---|
| `source_root` | string | —（回显；文件写到 `stage_dir`） |
| `stage_dir` | string | —（空目录/每次操作独立目录） |
| `evidence_path` | string | —（不存在 = 全量扫描） |
| `manifest_path` | string | —（不存在或不可读 = 用本次导出重建） |
| `adopt_existing` | bool | `false`（首次建账本的捷径，见下） |
| `device_name` / `software_name` | string | 自动 |
| `export_options` | `none` \| `with_defaults` \| `with_read_only` | `with_defaults` |

`adopt_existing`（首次建账本）：**没有上一版账本**、且 `_manifest.json` 可用时，不再把 1376 个文件
重新导出，而是逐条校验清单行、把仍与磁盘文件一致的条目**直接采信为证据**：

- 行必须有非空**相对** `file`、`verified: true`、非空 `sha256`；
- 文件必须落在 `source_root` 内（`Path.GetFullPath` + 前缀校验，越界行一律不采信，绝对路径行也不采信）；
- `Hashing.Sha256OfFile` 必须与清单 `sha256` 相同（大小写不敏感）；
- 块 / 类型：只把 `entry.Path` 指向该文件；标签表：还要能读出来，把
  `entry.ContentHash` 记成 `sha256:` + 归一化 XML 的哈希，读不出就留给导出。

被采信的键从导出计划里移除（标签表计划也过滤），因此 `stage.files` 只计**本次真正写出的文件**，
另有 `adopted` 报采信数量。上一版账本存在、或清单不可用时该参数**完全不生效**，退回原来的全量导出路径。

比对口径：

- 块 / PLC 类型：`FingerprintProvider` 的全部面，逐面比较；
- 安全块：在上面之外再记 `SafetySignatureProvider` 的 `BlockOfflineSignature`。先按块属性预筛
  （`ProgrammingLanguage` 是 `F_*`，或对象是 OB——`FOB_SAFETY` 这类安全系统 OB 的语言是 SCL），
  只对候选块问 provider；provider 为 null 即非 F 块，返回值 0 表示"尚无有效签名"。
  这些签名参与变化判定，并且**包括导不出的 F 块**：`FOB_SAFETY` 没有文件可导出，F 签名是它唯一的变更证据；
- 标签表：没有指纹，**每次都导出**后比较归一化内容哈希（去掉 `<DocumentInfo>`、统一换行，
  `hashAlgo = xml-norm-v1`）；
- 删除：当前枚举里不存在即写墓碑；被 TIA 拒绝导出的对象只进 `unexportable`，绝不当作删除。

账本里的 F 签名是**追加字段**（`safetyRecorded` + 每个 F 块的 `isSafetyBlock` / `safetySignature`），
`schemaVersion` 仍为 1。旧账本没有 `safetyRecorded`，因此升级后的第一次同步会强制走一次扫描把签名补上，
但**不会**把 55 个 F 块报成变更——这一次只用指纹判定，之后的同步才比较 F 签名。

`data`：`{ device, software, checksum, unchanged, counts{blocks,types,tagTables,changed,added,removed,unexportable}, safety{signatureType,fBlockCount,zeroSignatureCount,changed[]}, changed[], added[], removed[], unexportable[], stage{root,evidence,manifest,files}, manifestRebuilt, adopted, stateId }`。
`safety.changed[]` 是两版账本之间 F 签名变化的块（`{key,name,group,before,after}`），与文件是否变化无关，
所以落在 `unexportable` 里的 F 块也会出现在这里。
`checksum` 与账本一致时直接返回 `unchanged:true`、`stage:null`，**不枚举、不导出**。
同一调用会在 `stage_dir` 写 `_evidence.json`（账本）与 `_manifest.json`（清单）：
未变化对象从上一版清单原样带过来，只有归一化内容真的变了的标签表才进入 STAGE；
清单不含时间戳、不含绝对路径（`file` 相对设备根）。
真机实测（`PEI_SinoARP_SWT2`，1155 块，2026-10-22）：`unchanged` **1.6–3.0 s**；
1 块变化 **48.3 s**（导出 1 块 + 7 个标签表 = 8 文件，清单优化前）；全量 **121–231 s / 1376 文件**。
枚举 + 全部指纹约 30 s，是固定成本；变化块越多，导出时间越长。
2026-10-24 在 `SWT2_PEI_FJib_Hold`（F-CPU，1155 块 / 55 个 F 块）复测：旧账本补签名 **91 s**、
`changed=0`（回填不误报）、`fBlockCount=55 / zeroSignatureCount=10`，`FOB_SAFETY` 留在
`unexportable` 且带 `safetySignature`；之后同一账本的快路径 **4 s / unchanged**。
F 签名只对候选块（`F_*` 语言或 OB）探测，额外开销是一次枚举里多几十次 `GetService`。
错误码：`checksum_unavailable` `evidence_invalid` `evidence_version_mismatch`
`evidence_device_mismatch` `project_not_open`。

---

## 23. ExportHardwareConfig / `export_hardware_config`（只读，只写文件）

把当前工程**整份硬件组态**导出为单个 AutomationML（CAx/AML，CAEX 2.15）文档。
对应手册 "Export of CAx data" 的工程级分支：`project.GetService<CaxProvider>()` 后
`Export(project, aml, log)`。V17 的 `CaxProvider` **没有** `CaxExportOptions`
（反射实证：`Siemens.Engineering.Cax` 只有 `CaxProvider` / `CaxImportOptions` /
`CaxProviderFactoryFacade` 三个类型），所以导出没有范围参数：工程级就是全部设备一个文件，
要按设备得逐台调 `Export(device, …)`（本操作未暴露）。

**执行方式**：包在独占访问里（`OpennessHost.BeginExclusiveAccess`）——只读操作也拿独占，
避免读取期间有人改组态。**不包事务**（不需要 undo 单元，也避开手册事务禁区），**不 Save**。

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `output_dir` | string | — | 落盘目录，绝对路径；不存在则创建。工具侧默认传 `<workspace>/hardware` |
| `file_name` | string | `globalHardware.aml` | 纯文件名，必须以 `.aml` 结尾，不得带目录部分 |
| `overwrite` | bool | `true` | 覆盖已存在文件；`false` 则 `output_exists` |

`data`：`file` `fileName` `outputDir` `bytes` `sha256` `rootElement` `deviceCount`
`allObjectsExported` `logSummary{errors,warnings,clean}` `logProblems[]`
`notInAml[]` `notInAmlCount` `notInAmlNote` `logPath` `logExcerpt`（日志**尾部** 4000 字符）。

`notInAml[]` 是"AML 里没有的设备"的结构化描述，每一行都在同一次独占访问里从工程模型读出来：
`device`、`kind`（设备的软件是 HMI target 时为 `hmi`）、`reason`（TIA 日志原话）、
`typeIdentifier` / `typeName` / `orderNumber`（尽力而为）、`deviceItemCount`、
`nodes[]{deviceItem,node,address,subnetMask,pnDeviceName,netType,interfaceType,subnet}`。
**这些正是 AML 条目会带的字段**——HMI 没有 CAx 类模型，所以它的 IP 只能出现在这里。
`deviceCount - notInAmlCount` 就是文件覆盖到的设备数。

要点：

- **产物回读校验**：空文件、非 XML、缺 `CAEXFile` 根元素都算 `verification_failed`，
  不会把"TIA 说成功"当成成功；
- **`Export` 的 bool 语义（实机实测，2026-11-02）**：它是"所有对象都导出了"，不是"产出文件了"。
  `PEI_SinoARP_SWT2` 上返回 **false**，却写出了完整的 1.4 MB CAEX 2.15 文档，日志结尾是
  `completed (errors: 1, warnings: 0)`，唯一那条 error 是
  `device HMI_1 is being skipped. The required attribute TypeIdentifier is invalid or missing.`
  —— 正是一个 CAx 无法表达的对象。所以 **false + 合法文件 = 部分成功**：操作成功返回，
  `allObjectsExported:false`，`logProblems[]` 逐条列出被跳过的对象与原因；
- **日志**：TIA 写到同级 `<name>.log`（本项目 108 KB、上万行 INFO/DEBUG）。只取**尾部** 4000 字符
  ——头部全是逐对象进度，结论和 ERROR 在末尾；`logProblems` 另外把 ERROR 行抽出来并去重（最多 20 条）；
- **`deviceCount` 是全部设备**：`Project.Devices` + 未分组系统组 + 递归用户组，按名去重。
  实测 `PEI_SinoARP_SWT2` 的 `Project.Devices` 只有 **1** 个，而 CAx 日志导出的是几十个（都在用户组里），
  所以只数扁平层会给出荒唐的数字；
- **AML 不是完整清单，但手册清单也不是可靠预测**：手册同条目列出 CAx 不支持的导出对象（除按键面板外的 HMI、
  多 CPU、扩展机架连接、端口到端口连接、模拟量通道输出模式/量程、压缩地址、以及"驱动"，另有一批 MLFB）。
  **实测（2026-11-02，18 台设备的工程）只跳过了 1 台 HMI，17 台全部导出——包括 GSDML 形式的驱动和第三方 GSD 设备**。
  所以"丢了什么"以 `logProblems` 为准，不要按类别假设；
- **不解析 AML**：本操作只交付文件 + 哈希 + 日志摘要，设备/模块/插槽/地址的结构化读取
  是后续增量（见 `docs/HARDWARE-CONFIG-SCOPE.md`）。

错误码：`project_not_open` `invalid_params` `output_exists` `exclusive_access_failed`
`cax_unavailable` `cax_export_failed` `verification_failed`。

---

## 24. HardwareInventory / `hardware_inventory`（只读，不需要工程）

解析 `export_hardware_config` 产出的 AML，返回**元器件身份**。走 `SupportedRoleClass` 分类
（`Device` / `DeviceItem` / `CommunicationPort` / `CommunicationInterface` / `Node`），
**不用** `RefBaseClassPath`（V17 导出里 442 个元素全为空）。

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `aml_path` | string | `<cwd>/hardware/globalHardware.aml` | 导出文件路径 |
| `device` | string | 全部 | 只看一台设备 |
| `include_comments` | bool | `true` | 多语言 `Comment` |
| `include_counts` | bool | `true` | 每模块通道数与总计 |

`data`：`aml{path,bytes,sha256,schemaVersion,project}`、`devices[]{…}`、`counts`。
设备 → `racks[]` → `modules[]`（`slot`/`orderNumber`/`typeName`/`deviceItemType`/`builtIn`/
`firmwareVersion`/`channels{di,do,ai,ao,total}`）。

**不含任何地址与网络字段**——那是 `hardware_configuration` 的职责（见 §25 与
`docs/HARDWARE-TOOL-TAXONOMY.md` §4.1 的决策）。

## 25. HardwareConfiguration / `hardware_configuration`（只读，不需要工程）

同一份 AML 的**组态值**：

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `aml_path` | string | 同上 | 导出文件路径 |
| `device` | string | 全部 | 只看一台设备 |
| `sections` | array | 全开 | `addresses` `channels` `tags` `network` `links` `signals` `f` |

- `addresses`：模块的地址组（`StartAddress`/`Length`/`IoType`），AML 里是嵌套 Attribute；
- `channels`：通道 `Type`/`IoType`/`Number`/`Length`；
- `tags`：PLC 侧 `…/Tag` 接口（`DataType`/`LogicalAddress`/`Comment`）；
- `network`：子网、节点（IP/掩码/PROFINET 名/协议）、IO 系统；
- `links`：`port-port`(16) / `node-subnet`(17) / `interface-iosystem`(15)，来自 `<InternalLink>`；
- `signals`：通道↔PLC 标签的信号映射（356 条）；
- `f`：F 源/目的地址与上下界。

全量在一次 18 设备 / 500 标签的工程上约 **245 KB**，用 `sections` 收窄。
真机实测（`SWT2_PEI_1026_Night`）：`hardware_inventory` 167 ms、`hardware_configuration` 180 ms。

---

## 26. HardwareParameters / `hardware_parameters`（只读，**需要打开的工程**）

读 CAx/AML 永远不会带的那一层：模块/通道的**参数**。没有白名单——属性名随型号变化，
Openness 只发布运行期 `GetAttributeInfos()` 的名字与 `AccessMode`。

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `device` | string | — | 必填 |
| `item` | string | 整台设备 | 设备项路径，`/` 分隔按名匹配，或 `#<slot>` 按槽位 |
| `channel` | int | 全部 | 只看某通道号 |
| `attribute` | string | 全部 | 只看某属性；未知名字 → `attribute_not_found` + `details.available` |
| `mode` | enum | `list` | `list` 只列名字+权限；`values` 连值一起读 |
| `include` | array | `attributes,channels` | 另有 `gsd`（GSD 身份） |
| `max_items` / `offset` | int | 200 / 0 | 设备项分页 |

实现要点：

- 复用 `OpennessHost.AttributeInfosOf` / `TryReadAttribute`；`Channel` 本身是 `IEngineeringObject`，
  同一套 helper 直接可用；
- **两段式**：`list` 只调一次 `GetAttributeInfos()`；`values` 才逐属性取值。整台设备的 `values`
  可能上千属性，用 `item` 收窄；
- 值序列化：枚举取名字、`DateTime` 取 ISO-8601、`byte[]` 取 base64，其余原样；
- **不写任何属性**：`SetAttribute` / `SetPrmData` / `ConnectToPort` 都不在本操作内。

覆盖到 P1a：设备项 + 通道 + GSD 身份。P1b（`GetPrmData` 参数块）、P1c（端口/连线/MRP/MAC）
见 [`HARDWARE-PARAMETERS-PLAN.md`](HARDWARE-PARAMETERS-PLAN.md)。

---

## 27. ShowBlocksInEditor / `show_blocks_in_editor`

把程序块打开在 **TIA Portal 的块编辑器**里（等价于在项目树里双击这些块），**一次请求批量打开**。
这是本插件唯一一个"效果是界面动作"的操作：它不写工程、不存盘，只让编辑器出现。

API：`Siemens.Engineering.IShowable.ShowInEditor()`（V17 反射实证：该接口只有这一个成员，
无参数、返回 `void`；`PlcBlock` 与 `OB`/`FB`/`FC`/`DataBlock` 等 13 个类型实现它——
另外还有 `PlcTagTable`、`PlcWatchTable`、`PlcForceTable`，本操作只打开块）。
手册对应条目：Functions for accessing the data of a PLC device → Blocks →
"Starting the block editor"。

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `block_names` | string[]（必填） | — | 要打开的块，按顺序；可写 `Main` 或 `Motors/FB_Motor`；重名只打开一次 |
| `device_name` / `software_name` | string | 自动 | 工程里有多个 PLC 时选择 |

`data`：`device` `software` `withUserInterface` `requestedCount` `count`
`opened[]{name,group,kind,programmingLanguage,number,…}` `failedCount`
`failed[]{name,group,kind,code,message}` `maxEditorBlocks`(=100)。
`kind` 是具体块类型（`OB`/`FB`/`FC`/`GlobalDB`/`InstanceDB`/`ArrayDB`/`DataBlock`），
其余字段与 `list_plc_objects` 的块条目同形（都来自 `OpennessHost.DescribeBlock`）。

语义与前置条件（全部有错误码兜底）：

1. **必须有带界面的 TIA Portal**。工程是 `open_project(with_window=false)` 打开的、
   或者会话里那个实例本来就是无界面的，就报 `editor_unavailable`，并在 `error.details.hint`
   里给出唯一正确的补救：`close_project` 之后用 `with_window=true` 重开（或 `adopt_open_project`
   接管操作者已经开好的窗口）。理由：`ShowInEditor` 是界面命令，无界面实例没有编辑器可开；
   工程句柄属于那个无界面实例，换实例只能重开。
   "有没有界面"由 `TiaPortalProcess.Mode` / 创建时的模式记录在 `OpennessHost.HasUserInterface`，
   所以 `open_project` / `create_project` / `archive_project(retrieve)` 的 `data.withUserInterface`
   现在报的是**实际**模式，不是调用方请求的值。
2. **先解析，后打开**。名单里每个名字都在打开第一块之前解析完：未命中 → 整单 `block_not_found`
   （`details.missing` + 块不多时给 `details.available`）；裸名字在多个用户组里存在 →
   `block_ambiguous`（`details.ambiguous` 给出候选，用 `Group/Name` 消歧）。这样打错一个字
   不会让半批编辑器留在界面上。
3. **逐块独立**。单个块被 TIA 拒绝（最典型是 know-how 保护块弹密码框）只记进 `failed`，
   其余照常打开；只有**一块都没打开**才 `editor_show_failed`（此时 `data` 里仍有完整失败清单）。
4. **单次上限 100 块**（`MaxEditorBlocks`），超出报 `too_many_blocks` —— TIA 一个块一个编辑器页签，
   把 1155 个块一次全开等于把界面埋掉。
5. **没有 `dry_run`**（决策 D22）：预览只能复述入参，没有信息量；风险也不落在工程上。
6. 界面弹框（密码、只读提示）会把这一次调用挂住，直到有人在 TIA 里处理完 ——
   工具描述里写明了这一点，超时按 `requestTimeoutMs` 处理，不是控制器失败。

`changes` 逐块记 `{kind: "block", target: "<group>/<name>", action: "shown_in_editor"}`：
它记录的是"操作者在界面上看到了什么"，不是工程改动。

**真机实测（2026-11-04，V17，`PEI_HF_M4L_ZRW_Test_V5.1`，782 块，带界面会话）**：

| 调用 | 结果 |
|---|---|
| `["Main_Cav_A"]` | `ok` 3.1 s；`opened[0]` = `{kind:"OB", group:"01_Cavité_A/", programmingLanguage:"LAD", number:123}` |
| 三个名字一次给（OB + `999_Bibliotheque/Fonctions méthode/1001_SCP_IN/SCP_IN` + InstanceDB） | `ok` 5.2 s；3 块全开，`kind` 分别 `OB` / `FB` / `InstanceDB` |
| `["NoSuchBlockXYZ"]` | `block_not_found`；`data` 为空（一个编辑器都没开），`details.availableCount:782` |

即：逐块约 1.7 s；带空格与非 ASCII 字符的组路径（`méthode`、`Cavité`）能被 `Group/Name` 解析。

错误码：`project_not_open` `plc_software_not_found` `plc_software_ambiguous` `editor_unavailable`
`block_not_found` `block_ambiguous` `too_many_blocks` `editor_show_failed` `editor_not_supported`
`invalid_params`。