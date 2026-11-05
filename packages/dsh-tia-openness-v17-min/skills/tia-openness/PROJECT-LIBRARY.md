# 项目库（Project library）与库管控块

本文件是 `tia-openness` 路由 skill 的项目库专题，和 `docs/PROJECT-LIBRARY.md` 同源；
面向运行时在用户工程里工作的模型，重点是“遇到库管控块该怎么办”。

## 1. V17 Openness 能做什么

`Project.ProjectLibrary` 有两棵树：

| 树 | 版本 | Openness V17 |
|---|---|---|
| `Types`（类型版本） | 有（`InWork`/`Committed`） | 枚举、`Export`、`SetAsDefault`、`Delete`、`FindInstances`、`Dependencies`/`Dependents` |
| `Master copies`（主副本） | 无 | 枚举、`Create`、`CreateFrom`、`Delete`、`Rename`、实例化 |

**类型版本的完整“导出→编辑→导入库版本→发布→更新实例”不能用 Openness 独立完成**：

| 段 | 能否 |
|---|---|
| 导出库版本 | ✅ `LibraryTypeVersion.Export` |
| 编辑 XML | ✅ 离线 |
| 导入成库版本 | ❌ 无 Import |
| 新建类型版本 | ❌ 无 CreateVersion |
| Release / Committed | ❌ `State` 只读，只能 TIA UI |
| 发布成主副本 | ✅ `MasterCopyComposition.Create`（无版本号） |
| 更新工程实例 | ✅ `ILibrary.UpdateProject`（只对已有、已 Release 的版本） |

所以：类型版本是“只读窗口 + 实例更新器”；主副本是另一条无版本闭环。

## 2. 库管控块不能直接改 XML 导入

TIA UI 的 check-in / 编辑 / release 是库感知流程；`ImportBlocks` 是项目级块导入，
不执行 check-in/update/release。

实测（SWT2 的 `SCP_OUT`，库版本 2.5.1，只改 `MemoryReserve`）：

- `ImportBlocks` 返回 `committed=true`、写后验证通过；
- 导入后块 `isConsistent=false`；
- `FindInstances` 返回 0，库实例链接丢失；
- 库版本 XML 内容不变（只有导出时间戳不同）；
- 再导出该块失败：`Inconsistent blocks and PLC data types (UDT) cannot be exported`。

**结论：导入会成功，但实例脱离库、库版本不变、块变成 inconsistent；Openness 之后既不能导出也不能修复。**

## 3. `import_blocks` 的护栏与模型标准动作

`import_blocks` 默认 `allow_library_managed_import=false`。导入前对目标块/类型查
`LibraryTypeInstanceInfo`（向 TIA 查，不依赖 XML 元数据），发现是库实例就返回
`library_managed_block`，事务不开始。dry run 返回 `libraryManaged[]`、`blocked:true`、`ready:false`。
SCL/STL 外部源按声明名检查。

错误详情包含 `blocks[]{name, group, library{type, version, versionGuid, state}}` 和
`recommendedActions`。模型应：

1. **不要重试 `allow_library_managed_import=true`**；
2. 用 `project_library action=use operation=instances` 或 `action=read` 查清库类型/版本/状态；
3. 给用户两条路选：
   - **路 A（推荐，库感知）**：用户在 TIA 里 check-out / 编辑 / release（或新建版本），
     agent 用 `project_library action=browse/read` 确认，再用
     `project_library action=use operation=update_project` 更新实例。Openness 只读、导出、更新实例。
   - **路 B（用户明确同意的 fork）**：导出块 XML，去掉 `LibraryType` /
     `LibraryTypeVersionGuid` / `LibraryConformanceStatus`，改一个新名字，作为**新的普通块**导入，
     然后由用户在 TIA 里把调用方改到新块。
4. 只给建议、不落盘也是合法路径：把 XML、diff 和修改说明交给用户，让用户在 TIA 里改并 release，
   agent 只负责复核。

## 4. fork 的三个前提

1. **必须去掉库元数据并改名**：保留 `LibraryType`/`LibraryTypeVersionGuid` 或保留原名，
   都会触发库关联/护栏。
2. **调用方不会自动更新**：Openness 不会重写 LAD/SCL 调用点；跨引用更新必须由用户/UI 完成。
3. **单向分叉，不是库更新**：原库管控块还在；新块不跟随后续库版本。只有用户明确接受
   “脱离库、后续不自动同步”，才应走这条路。

## 5. `source/` 与 `library/` 的边界

- `source/` 只有 PLC 软件树；`library/` 是项目库的独立树。
- 只在库、未实例化到 PLC 的块：**不在 `source/`，不会被 ingest 进知识图谱**。
- 已实例化的库管控块：PLC 实例在 `source/`，库版本/历史不在。
- `project_sync`/`project_diff`/`project_commit` 只认 `source/` + evidence；库变化不会出现在
  diff/commit，除非把 `library/` 加进基线/提交路径。
- 现有 `source/` 用 `with_defaults` 导出，ReadOnly 的 `LibraryType`/`LibraryTypeVersionGuid`
  不写进 XML；护栏在导入时查 TIA，不依赖这个标记。

## 6. 工具与错误码

- `project_library action=browse|read|export|write|publish|organize|use`
- `import_blocks` 的 `allow_library_managed_import`（默认 false）
- `library_managed_block`：拒绝覆盖库实例
- `library_type_version_publish_unsupported`：V17 无类型版本 Import/Create/Release
- `library_version_in_work`：InWork 版本不能导出
- `library_master_copy_inconsistent`：主副本内容不一致，Openness 拒绝导出/实例化

更完整的参数、实测与错误码见包内 `docs/PROJECT-LIBRARY.md`。
