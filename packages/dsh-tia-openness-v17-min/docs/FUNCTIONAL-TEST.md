# 功能测试：导出 → 修改 → 导入 → 编译

本文件描述**必须由人在真实 TIA Portal V17 项目上执行**的那一步。
自动化测试覆盖了协议、生命周期、白名单、dry-run（仅仍保留该参数的工具）、schema、Simatic ML 解析与 C# 自检，
但"块真的在 TIA 里进出"只能对着真实项目验证。

> 准备：一个 **V17** 项目（`.ap17`），里面至少有一个 PLC，且至少包含
> 一个 FC/FB 与一个 OB；当前 Windows 用户属于本地组 `Siemens TIA Openness`。
> 建议先复制一份项目副本，导入测试在副本上做。

---

## 0. 前置检查（不需要项目）

```powershell
# C# 控制器自检（13 项，不需要 TIA）
controller\bin\TiaOpennessV17Min.Controller.exe --self-test
# 关注：ok=true，failedCount=0，openness.available=true，
#       opennessUserGroup.isMember=true，openness_not_loaded_by_startup=true
```

在 DSH 会话里先问状态（不启动控制器、不碰 TIA）：

```jsonc
controller_status({ "include_controller_output": true })
```
期望：`Exe path` 指向包内 exe，`exists: yes`；`Openness: available ...`
（若显示 *The controller has not been started yet*，说明控制器尚未启动，这是正常的）。

---

## 1. 打开项目

```jsonc
open_project({ "project_path": "D:\\Demo\\Demo.ap17" })
```

**期望**

- `ok: true`，`data.projectName` / `data.projectPath` 正确；
- `data.plcSoftware.count >= 1`，`data.blockSummary.count > 0`；
- 如果项目是旧版本创建的：不加 `allow_upgrade` 会失败（`project_open_failed`），
  这是**设计如此**——升级会重写项目文件，必须显式传 `allow_upgrade: true`。

同时观察任务管理器：会出现一个 `TiaPortal.exe`（headless，看不到窗口）。这是正常的。

---

## 2. 导出块

```jsonc
export_blocks({ "output_dir": "D:\\Demo\\export" })
```

**期望**

- `data.summary.exported` = 块数，`failed = 0`，每个文件 `verified: true`；
- 目标目录里出现与导出前 `data.blockSummary.items[].name` 对应的 `.xml` 文件；
- 出现 `_tia-openness-manifest.json`，其中每个块有 `sha256` 与 `bytes`；
- 用文本编辑器打开其中一个 XML：根元素 `<Document>`，内含 `<SW.Blocks.FC>` 之类元素，
  以及 `<AttributeList><Name>…</Name>`（这就是 Simatic ML）。

> 记录该文件的 SHA-256（`Get-FileHash <file> -Algorithm SHA256`），第 3 步修改后用它确认真的变了。

---

## 3. 修改导出的 XML

选一个 FC（例如 `FC_Test.xml`），在 `<AttributeList>` 里做一处**可编译且可观察**的改动，
例如给一个 SCL 块的接口加一个输入变量，或在块注释里写入一个标记。

最稳妥的最小改动（不会引起编译错误）：

```xml
<Comment>
  <MultiLanguageText Lang="zh-CN">TIAOpennessV17Min functional test marker</MultiLanguageText>
</Comment>
```

插入到 `<AttributeList>` 中（若已有 `<Comment>` 则替换其文本）。
然后用 `Get-FileHash` 确认文件哈希已变化。

---

## 4. 导入块（默认 dry-run）

```jsonc
import_blocks({ "import_paths": ["D:\\Demo\\export\\FC_Test.xml"] })
```

**期望**

- `ok: true`，`data.dryRun: true`；
- `data.plan[0].blockName` = `FC_Test`，`existsInProject: true`；
- `data.plan[0].action`：
  - `"conflict"`（默认 `import_options: "none"`）→ 说明 TIA 会因块已存在而拒绝导入，
    `data.conflicts` 里也会列出；这是**正确的预警**；
  - 若你传了 `import_options: "override"`，则是 `"overwrite"`；
- 项目**没有被修改**（`data.committed` 不存在）。

真正导入：

```jsonc
import_blocks({
  "import_paths": ["D:\\Demo\\export\\FC_Test.xml"],
  "import_options": "override",
  "dry_run": false
})
```

**期望**

- `data.committed: true`；
- `data.verification.passed: true`，`missing: []`；
- `data.verification.blocks[0].modifiedDateAfter` 与 `...Before` **不同**
  （这是"读回项目"的实证：块确实被写入了）；
- `data.verification.blocks[0].differences` 为空（若不空，说明文件里的
  `Number`/`ProgrammingLanguage` 与项目中读回的不一致，工具会列出差异而不隐藏）；
- 在 TIA Portal 里打开该项目（或重新导出该块）应能看到第 3 步写入的标记。

**故意失败一次**（验证事务回滚）：把 `import_paths` 指向一个不存在的块名文件，
或把一个 XML 改坏，再 `dry_run: false` 导入：

```jsonc
import_blocks({ "import_paths": ["D:\\Demo\\export\\broken.xml"], "dry_run": false })
```
期望：`ok: false`，`error.code` 为 `invalid_file` 或 `import_failed`，
`error.message` 明确写出"transaction was rolled back, so the project is unchanged"，
并且第 4 步之前的改动仍然完好（块没有被破坏）。

---

## 5. 编译验证

```jsonc
compile_plc({})                          // 直接编译；编译会改变工程的编译状态
```

**期望**

- 返回 `data.state`（`Success`/`Warning`/`Error`）、`data.errorCount`、
  `data.warningCount`、`data.messages[]`；
- 刚导入的块可编译：`errorCount = 0`（warning 允许）；
- 若 `errorCount > 0`：这是**数据**而不是工具错误，请按 `messages[].description` / `path` 定位；
  常见原因是第 3 步的修改引入语法错误——把它改回去重跑即可验证整条链路。

---

## 6. SCL 外部源路径（可选）

把一段 SCL 源码存成 `D:\Demo\src\MyBlocks.scl`：

```scl
FUNCTION_BLOCK "FB_FromSource"
VAR_INPUT
  start : Bool;
END_VAR
BEGIN
END_FUNCTION_BLOCK
```

```jsonc
// 预演：扫描文件里声明的对象（FUNCTION_BLOCK/FUNCTION/DATA_BLOCK/TYPE）
import_blocks({ "import_paths": ["D:\\Demo\\src\\MyBlocks.scl"] })
// 期望 data.plan[0].format = "external_source"，data.plan[0].exactTarget = false，
//      data.plan[0].action = "generate"

// 真导入：控制器把 SCL 加入项目 → 生成块 → 删除临时外部源
import_blocks({ "import_paths": ["D:\\Demo\\src\\MyBlocks.scl"], "dry_run": false })
// 期望 data.verification.passed = true，块 FB_FromSource 出现在项目里；
//      keep_source 默认 false，因此外部源不会留在项目中
```

---

## 7. 收尾

```jsonc
close_project({ "save": true, "dry_run": false })          // 保存并关闭项目
close_project({ "save": true, "close_portal": true, "dry_run": false })  // 连 TIA Portal 实例一起关掉
```

**期望**：`data.saved: true`，`data.closed: true`；（可选）`data.portalClosed: true`，
并且任务管理器里那个 headless `TiaPortal.exe` 消失。

最后卸载插件（禁用/移除该 bundle，或结束 DSH 进程），确认：

```powershell
Get-Process -Name TiaOpennessV17Min.Controller -ErrorAction SilentlyContinue
```
**期望**：没有任何输出——子进程随插件卸载被终止（这一点也有自动化测试覆盖：
`test/02-lifecycle.test.mjs`）。

---

## 8. 结果记录表

| 步骤 | 期望 | 实际 | 通过 |
|---|---|---|---|
| 0 控制器自检 | `ok=true`，13/13 | | ☐ |
| 0 `controller_status` | exe 存在，Openness available | | ☐ |
| 1 `open_project` | `plcSoftware.count ≥ 1` | | ☐ |
| 2 `export_blocks` | `failed=0`，manifest 有 sha256 | | ☐ |
| 3 修改 XML | 文件哈希变化 | | ☐ |
| 4 dry-run 导入 | 计划/冲突正确，项目未变 | | ☐ |
| 4 真导入 | `committed=true`，`verification.passed=true`，`ModifiedDate` 变化 | | ☐ |
| 4 故意失败 | 回滚，项目未被破坏 | | ☐ |
| 5 `compile_plc` | `errorCount=0` | | ☐ |
| 6 SCL 外部源 | 生成块并读回验证通过 | | ☐ |
| 7 `close_project` | `saved/closed=true`，TIA 进程按需退出 | | ☐ |
| 7 卸载插件 | 无残留控制器进程 | | ☐ |

---

## 8.5 真实项目实测出来的三条硬约束（必读）

1. **有些块 Openness 根本不能导出/导入**（不是权限问题，是 TIA 的限制）：
   - ProDiag 生成的块：`The programming language 'ProDiag_OB' is not supported during import and export.`（`ProDiag` 同理）；
   - Safety (F-) 块：`The export of block 'FOB_RTG1' is not permitted.`
   控制器会**逐块记录**在 `data.failures[]` 并继续导出其余块（`summary.failed` 计数），
   所以一个 237 块的真实项目导出 234 个、拒绝 3 个是**正常结果**，不是失败。
2. **导入必须回到块原来所在的组**：导入按"全 PLC 名字/编号唯一"判断，把用户组里的块导入到根组时，
   即使 `import_options: "override"` 也会失败：`An object with this name or this number already exists`。
   用法：`target_group: "999_Kautex"`（或对目录用默认的 `mirror_groups: true` 自动按子目录还原）；
   缺少组时传 `create_group: true`。
3. **重新导出必须放在编译之后**：实测"导入后立刻导出该块"会被拒绝（`refused all 1 block(s)`），
   编译（`errors=0`）之后同一导出成功。所以"改 → 导入 → 重新导出对比"的会话顺序是
   **导入 → 编译 → 重新导出**（`test-profile/test-roundtrip.ps1` 已按此实现）。
## 9. 常见失败与处理

| 现象 | 原因 | 处理 |
|---|---|---|
| `openness_unavailable` | 找不到 V17 的 `Siemens.Engineering.dll` | 确认安装，或配置 `opennessDir` / `TIA_OPENNESS_V17_DIR` / `TiaPortalLocation` |
| `openness_load_failed` | 位数或依赖问题 | 确认 x64，且控制器是用 `npm run build:controller`（含 NuGet 还原）构建的 |
| `project_open_failed` 且 hint 提到 access denied | 用户不在 `Siemens TIA Openness` 组，或项目被占用 | `net localgroup "Siemens TIA Openness"`；关闭已打开该项目的 TIA 窗口 |
| **弹出一个询问是否允许该应用访问的对话框 / 连接被拒绝，而用户组正常** | **Openness 应用白名单（Openness 防火墙）**：V17 手册（SIOS 109798533）有"白名单条目"章节，headless 控制器无法点这个对话框 | 见下方说明 |
| `transaction_failed` | 已有另一个 Openness 客户端在改这个项目 | 只保留一个客户端（本控制器只允许一个实例） |
| `controller_timeout` | 大项目导出/编译超过 `requestTimeoutMs` | 调大 `requestTimeoutMs`（编译大项目常需 10 分钟以上） |
| 导入报块已存在 | `import_options: "none"` | 传 `"override"`，或改块名 |
| 导入后 `verification.missing` 非空 | 块名与文件声明不一致 / 导入被 TIA 拒绝 | 看 `error.details.verification.blocks[]` 与控制器诊断 |

#### 关于白名单（Openness 防火墙）

本控制器的 Openness 解析已换成 Siemens 官方包，而官方解析器**自带**
`IsAppWhitelisted()` / `WhitelistApp()`；**本插件目前没有调用它们**。如果你的 TIA Portal 版本强制要求
应用白名单，第一次 `OpenProject` 可能被拒绝或弹出需要人点击的对话框（headless 控制器答不了）。
排查顺序：

1. 先确认不是用户组问题（`controller_status` 会显示 `Siemens TIA Openness` 成员状态）；
2. 查注册表是否存在白名单项，以及控制器 exe 是否在列
   （`HKLM\SOFTWARE\Siemens\Automation\Openness\<版本>\Whitelist`）；
3. 需要程序化处理时，用官方解析器的 `WhitelistApp()`：它在
   `Siemens.Collaboration.Net.TiaPortal.Openness.Resolver` 的全局命名空间扩展方法里，
   签名是 `WhitelistApp(IOpennessMarker)`，取 marker 的方式与
   [OpennessBootstrap.cs](https://github.com/) 中的 `Api.Global.Openness()` 相同
   （本仓库 [controller/OpennessBootstrap.cs](../controller/OpennessBootstrap.cs)）。

把结果（需不需要白名单、V17 下是否真的拦截）记回
[`docs/verification.md`](verification.md) §C。
