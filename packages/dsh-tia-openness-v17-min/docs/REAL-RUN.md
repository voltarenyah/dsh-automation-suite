# D. 真实环境实测记录（本轮）

这一节保存**真实环境**跑出来的原始结果与真实缺陷，供复核。环境：Windows、TIA Portal V17 Update 7、
项目副本 `C:\tia-openness-test\KPH_CellController_0822\`（213 MB，1 个 PLC，237 个块）、
DSH 桌面端版本（隔离 `DSH_HOME=C:\tia-openness-test\dsh-home`）。

复现命令（三者都可重跑）：

```powershell
# 第 0 层 + 导出（只读段 + 真导出到临时目录）
pwsh -NoProfile -File test-profile\test-controller.ps1 `
  -ProjectPath C:\tia-openness-test\KPH_CellController_0822\KPH_CellController_0822.ap17 `
  -ExportDir C:\tia-openness-test\export -Execute

# 第 2 层：改 → 导入 → 编译 → 重新导出对比
pwsh -NoProfile -File test-profile\test-roundtrip.ps1 `
  -ProjectPath C:\tia-openness-test\KPH_CellController_0822\KPH_CellController_0822.ap17 `
  -BlockXml C:\tia-openness-test\export\999_Kautex\FB_Array_Handling.xml -Compile

# 第 1 层：真实宿主装载/退出（隔离 home，不动 ~/.dsh）
$env:DSH_HOME = 'C:\tia-openness-test\dsh-home'
pwsh -NoProfile -File test-profile\test-dsh-load.ps1 -Profile tia-test -Port 3080
```

## D.1 打开真实项目

```
[OK] o1 真打开项目
     项目 'KPH_CellController_0822'，PLC 软件 1 个，块 237 个，打开耗时 24227 ms
       - S7-1500/ET200MP station_1 / PLC_KPH_CellController_SIM（237 块）
```
首次（TIA 冷启动）70.1 s；后续 9.8–24.2 s。会话含 2–5 个 `progress` 帧，长操作可观测。
打开后**无残留 `TiaPortal.exe`**（控制器退出时释放自己启动的实例）。

## D.2 导出 237 个块

```
[OK] e1 真导出（只写文件系统，不改项目）
     导出 234，跳过 0，Openness 拒绝 3，写出后读回失败 0
     235 个文件 / 33.9 MB；用户组目录层级保留（0_OB_Groups、02_Machine_General、04_Safety、
       10_Cell、20_Press、30_Extrusion、40_OvenA、50_OvenB、999_Kautex …）
```
被拒绝的 3 个块（两类真实限制，**逐块记录、不影响其余导出**）：

| 块 | 原因（TIA 原文） |
|---|---|
| `ProDiagOB` | `The programming language 'ProDiag_OB' is not supported during import and export.` |
| `Default_SupervisionFB` | `The programming language 'ProDiag' is not supported during import and export.` |
| `FOB_RTG1` | `The export of block 'FOB_RTG1' is not permitted.`（Safety F-OB） |

> 修复前：同样这批块，第 3 个块抛错即中止，**只写出 2 个文件**。

## D.3 改 → 导入 → 写后验证 → 重新导出 → 编译

```
1) 块 'FB_Array_Handling'：<HeaderVersion> '0.1' → '0.2'
   目标组: 999_Kautex

[OK] d1 导入预演：目标块=FB_Array_Handling 类型=FB exists=True action=conflict 冲突=1
[OK] i1 真导入（事务 + 写后读回验证）
     committed=True 导入文件数=1
     写后验证: passed=True checked=1 confirmed=1 missing=
       FB_Array_Handling: found=True group='999_Kautex/' expected='999_Kautex'
         replacedExisting=True changed=True
         ModifiedDate: (空) → 10/13/2026 02:48:48
[OK] c1 真编译：state=Warning errors=0 warnings=13 messages=67
       [Success] Block was successfully compiled. FB_Array_Handling (FB34)
[OK] e1 重新导出该块：导出 1 个，file=...\reverify\999_Kautex\FB_Array_Handling.xml verified=True

3) 内容对比
   <HeaderVersion>: 原始导出 '0.1' → 改后的文件 '0.2' → 导入后重新导出 '0.2'
   [OK] 改动被真正写进项目
```

## D.4 真实项目测试抓出的三个缺陷（已修复）

| # | 缺陷 | 后果 | 修复 |
|---|---|---|---|
| 1 | 真实导出的 XML 是 `Document > Engineering > DocumentInfo > SW.Blocks.FB`，`SimaticMl.ReadHeader` 取了 `<Document>` 的**第一个子元素**（`<Engineering>`） | 导入预演报 `目标块=` 空、`类型=Engineering`；**写后验证静默通过**（`checked=0`、`passed=true`）；导出的读回校验里"块名比对"被跳过 | 新增 `SelectObjectElement`：优先取 `SW.*`，跳过 `Engineering`/`DocumentInfo`；并把"无块名/无对象元素"改为**硬失败** |
| 2 | 单块导出失败中止整批 | 237 块只写出 2 个 | 见 [decisions.md D14](decisions.md) |
| 3 | 导入固定落根组 | 用户组里的块即使 `override` 也无法覆盖（"name or number already exists"），往返流程不可用 | 见 [decisions.md D15](decisions.md)（`target_group` / `mirror_groups`） |

第 1 个缺陷尤其值得记录：它让**写后验证看起来通过但实际什么都没验**，正是任务书里
"不能仅凭没有抛出异常判断成功"要防的情况；只有对着真实导出文件跑才会暴露。

## D.5 真实 DSH 宿主装载 / 退出（隔离 home）

```
0) 前置检查：[OK] dsh CLI / tia-test profile（隔离 DSH_HOME）/ 插件已链接 / overlay / 端口 3080 空闲
   ~/.dsh 中不存在 tia-test → Create-Process 时未改动默认 profile
1) 启动第二个 DSH 实例：启动器 pid=9300 → 真正的宿主 pid=26464（dsh.cmd 是 cmd.exe 包装）
2) [OK] 控制器子进程已启动: pid=17680
   → 证明插件被真实 DSH 宿主加载，apply() 执行、ctx.effect 持有子进程
3) 结束宿主进程
4) [OK] 子进程随宿主结束而退出（控制器读到 stdin EOF 后自行退出，未残留）
```
事后核对：`~/.dsh/profiles` = `desktop, node_modules, web`（未被触碰）；3080 已释放；无控制器残留。

**这一步验证的是"宿主结束 → 子进程退出"的 stdin-EOF 路径**；`ctx.effect` 的 HMR disposer 路径
需要人在 UI 里禁用/启用插件才能触发（§B.1 第 4 步）。

## D.6 第二个真实项目（设备被放进用户组 → 又抓出一个缺陷）

项目：`C:\Users\Ansel\Documents\Automation\V17\PEI_SinoARP_Master_V4.1.3\`（497.7 MB / 176 文件，**正式项目，非副本**），
导出到其 `UserFiles\`。

**第一次运行（修复前）**：

```
[OK] o1 真打开项目
     项目 'PEI_SinoARP_Master_V4.1.3'，PLC 软件 0 个，块 0 个，打开耗时 11761 ms
[FAIL] 项目里没有 PLC 软件
[FAIL] e1 真导出: plc_software_not_found: The open project contains no PLC software
```

原因：`ListPlcSoftware()` 只遍历 `project.Devices`（未分组设备）。而 V17 的模型是
`project.Devices`（扁平/未分组）+ `project.UngroupedDevicesGroup.Devices`（"未分组设备"系统组）
+ `project.DeviceGroups`（**设备用户组**，`DeviceUserGroup.Devices` 且 `DeviceUserGroup.Groups` 可嵌套）。
**设备一旦被放进用户组，旧实现就完全找不到 PLC** —— 任何这类项目都会直接失败。

**修复后（第二次运行，exit=0）**：

```
[OK] o1 真打开项目
     项目 'PEI_SinoARP_Master_V4.1.3'，PLC 软件 1 个，块 1152 个，打开耗时 5848 ms
       - Sino_PEI / Sino_PEI（1152 块）
[OK] e1 真导出
     导出 1151，跳过 0，Openness 拒绝 1，写出后读回失败 0
     1152 个文件 / 70.6 MB（1151 XML + manifest），22 个顶层用户组目录，层级与非 ASCII 组名均正确
       （999_Bibliotheque\Fonctions méthode\1001_SCP_IN\SCP_IN.xml 等）
[WARN] FOB_SAFETY: The export of block 'FOB_SAFETY' is not permitted.（Safety F-OB，同 D.2 的第二类限制）
总耗时 81.7 s，1162 帧（含 1154 个 progress 帧）
```

项目完整性：`.ap17` 修改时间保持 `08/02/2026 13:20:58`（未变）；无锁文件；无残留 `TiaPortal.exe`；
无残留控制器进程。本次只执行 OpenProject / ExportBlocks（只读）/ CompilePlc 预演，控制器退出时 `Close()` 不带 Save。

**修复内容**：三层来源全遍历（`project.Devices` → `UngroupedDevicesGroup.Devices` → `DeviceGroups` 递归
`Devices`/嵌套 `Groups`），PLC 按 `ReferenceEquals` 去重；并把"找不到 PLC"的错误升级为**诊断**：
列出 `devices[]`（名称/所属组/deviceItem 数/是否有 SoftwareContainer/softwareType）与 `deviceGroups[]`，
这样"项目里只有 HMI 设备"这类正当输入能一眼看懂。