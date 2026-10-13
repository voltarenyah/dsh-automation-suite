# 清单差异分析：`metadata.json` vs `_tia-openness-manifest.json`

**本次只做分析，不实施任何改动。**

比对对象：

| | 文件 | 生成者 | 对象数 |
|---|---|---|---|
| **T** | `…\AutomationWorkbench\…\worktrees\master\devices\Sino_PEI\source\metadata.json` | 外部工具（**未确认是哪个工具**） | 1314（`DB 635 / Blocks 462 / UDT 210 / Tags 7`） |
| **M** | `…\PEI_SinoARP_Master_V4.1.3\UserFiles\_tia-openness-manifest.json` | 本插件 `export_blocks` | 1151 成功 + 1 失败 = 1152（仅 blocks） |

方法：读取两份文件的**完整字段并集**（含非空率）、取值域、子结构；对 T 的 `contentHash`
做了 2 个假设检验；再查 Openness V17 的 API 文档确认每个缺失字段**是否可读**（决定必要性）。
原始数据见本文各表；未做任何代码或数据修改。

---

## 1. 顶层结构

| 字段 | T | M | 说明 |
|---|---|---|---|
| `schemaVersion` | `"1.0"`（字符串） | `1`（整数） | 仅是类型差异 |
| `exportStartedUtc` / `exportFinishedUtc` | ✅ 有（可算导出耗时） | ❌ 只有 `generatedAt` | M 缺"导出区间" |
| `exportRoot` | ✅ 绝对路径 | ~ `outputDir`（等价） | 同义 |
| `device` | ✅ **对象**（12 个字段，见 §4） | ❌ 只有 `device`/`software` 两个字符串 | **M 缺一大块项目/设备元数据** |
| 对象数组 | `components[1314]`（四个类别同数组，靠 `folder`/`category` 区分） | `blocks[1151]` + `failures[1]` | 形状不同（见 §6） |
| `protocol` / `generatedBy` | ❌ | ✅ | M 有（对审计有用，T 无） |
| `exportOptions` | ❌（未记录导出选项） | ✅ `with_defaults` | M 有 |
| `counts{blocks,types,tagTables}` | ❌（可按 `folder` 统计） | ✅ | M 有 |
| `failureCount` | ❌（靠 `status`/`message`） | ✅ | 形状差异 |
| `categories` | ❌（靠 `folder`） | ✅ | 同义 |
| 每对象相对路径 | ✅ `exportedFile`（相对 `exportRoot`） | ❌ 只有绝对 `file` | **M 缺可移植路径** |

## 2. 每个对象的字段对照

| 语义 | T | M | 是否等价 |
|---|---|---|---|
| 名字 | `name` | `name` / `declaredName` | ✅（M 还多一个"文件里声明的名字"用于校验） |
| 所在组 / 组内路径 | `sourcePath`（`组/名`） | `group`（`组/`）+ `name` | ✅ 同义 |
| 类别粗分 | `folder`（Blocks/DB/UDT/Tags） | `category`（blocks/types/tag_tables） | ✅ 同义（T 把 DB 单列） |
| Simatic 类型 | `siemensTypeName`（InstanceDB/GlobalDB/ArrayDB/OB/FB/FC/PlcStruct/PlcTagTable） | `simaticType` + `element`（`SW.Blocks.FB`…） | ✅ M 略多 |
| 对象类型简称 | `category`（DB/FC/FB/UDT/OB/Tags） | ❌ | 细节；`simaticType` 可替代 |
| 编号 | `number`（1097 非空） | `declaredNumber`（1151 非空，取自文件） | ✅ |
| 编程语言 | `programmingLanguage`（1097 非空） | `programmingLanguage` | ✅ |
| 导出文件 | `exportedFile`（相对） | `file`（绝对） | 见 §1 |
| **稳定身份 id** | ✅ `id`（43 字符，疑似内容派生的稳定标识） | ❌ | **缺口** |
| **内容哈希** | ✅ `contentHash`（43 字符 base64url = SHA-256 长度） | ~ `sha256`（十六进制） | **不等价，见 §3** |
| **分层指纹** | ✅ `fingerprints{Code, Comments, Events, Interface, LibraryType, Properties}`（非空 1307） | ❌ | **缺口（最有价值的一项）** |
| **时间戳** | ✅ 4 个：`creationDate`(1307) / `modifiedDate`(1314) / `codeModifiedDate`(1097) / `interfaceModifiedDate`(1307) | ❌ 一个都没有 | **缺口** |
| **Know-how 保护** | ✅ `isKnowHowProtected`(1307，本样本全 False) | ❌ | **缺口（小，但预检有用）** |
| 结果状态 | ✅ `status`(1314 全 `Exported`) + `message`(0 非空) | `verified` + `failures[]` | 形状差异，信息量相当 |
| 规范标识 | `tiaIdentifier`（本样本 = `name`） | ❌ | 几乎无信息量 |
| 文件字节数 | ❌ | ✅ `bytes` | **M 独有** |
| 写出后读回校验 | ❌（校验是另一套：状态 + 指纹） | ✅ `verified` | **M 独有** |

## 3. 哈希语义：不是同一种东西（已用实验否定两个假设）

对 T 的 4 个对象（Blocks / DB / Tags / UDT 各一）逐字节检验：

| 对象 | `contentHash` | SHA-256(文件字节)→base64url | SHA-256(把 `<Created>` 清空) |
|---|---|---|---|
| `00_Main_CTR` | `yOoAsYrb…jcM` | `dGdPjnRb…cng` ❌ | `wGvXDeMx…1og` ❌ |
| `R_Screen` | `b2mtXtVb…h90` | `GmsASU2F…oRs` ❌ | `SWkq044u…D_E` ❌ |
| `Cure4.0` | `O3JWoQaj…92E` | `tvoI007Z…Ce4` ❌ | `h7w8cSVI…AtM` ❌ |
| `PHYS_VALUE_1` | `3lBe6hoV…c0A` | `TR4o2_xe…TO8` ❌ | `k-Gwyd7x…M3E` ❌ |

**两个假设都被否定**，所以 T 的 `contentHash` **不是**对导出文件的哈希。结合它同时能给出
6 个**分层**指纹（Code / Comments / Events / Interface / LibraryType / Properties），可判断它
是对**对象模型按切片**计算的语义哈希（因此与文件里的导出时间戳无关），但**具体输入与算法外部不可复现**
（可能含 `id`/`sourcePath`/规范化规则）。**我只拿到它的一次导出，无法验证它跨导出是否稳定**——
这一点必须承认是推断，不是实测。

**M 的 `sha256` 是"写出文件"的字节哈希**，而文件里含 `<DocumentInfo><Created>`（每次导出都不同，
我们已与 T 的文件逐字节比对过：唯一差异就是这一行）。因此：

> **M 的 `sha256` 不能用作变更检测的键**：项目内容没变、只要重新导出一次，哈希就会变。
> 它现在的用途只有"同一份 manifest 内的完整性/防篡改审计"（这一点是成立的）。

## 4. T 的 `device` 块（M 完全没有）

```
plcName=Sino_PEI   deviceName=Sino_PEI   typeIdentifier=OrderNumber:6ES7 515-2FM01-0AB0/V2.9
projectName=tia    projectAuthor=F280896 projectVersion=4.1.3
projectComment=(空)  projectCopyright=(空)
projectCreationTime=2015-03-18  projectLastModified=2026-09-16  projectLastModifiedBy=Ansel
isSafetyDevice=True
fSignatureReadState=ok
fSignature=3C DF 5D 2F … (32 字节)
fBlockSignatures=(空)
```

**可行性核对（Openness V17 API 文档）**：

| 字段 | Openness 可得性 |
|---|---|
| `projectAuthor/Copyright/CreationTime/LastModified/LastModifiedBy/Version/Comment/Name/Path/Size/IsModified/Family` | ✅ 全是 `ProjectBase` 的静态属性（`P:Siemens.Engineering.ProjectBase.*`） |
| `typeIdentifier`（订货号 + 固件） | ⚠️ 无静态成员，属**动态属性**（`DeviceItem.GetAttribute("OrderNumber")` 之类）；本插件已有 `GetAttributeInfos()/GetAttribute()` 通道，但属性名需现场枚举一次 |
| `isSafetyDevice` | ⚠️ 需现场确认（可能同为动态属性，或由是否取到 F 签名推断） |
| `fSignature` / `fBlockSignatures` | ✅ `GetService<SafetySignatureProvider>().Signatures`（`SafetySignatureComposition` → `SafetySignature{Type,Value}`，`SafetySignatureComposition.Find(SafetySignatureType)`） |
| 每对象 4 个时间戳 + `IsKnowHowProtected` | ✅ `PlcBlock.CreationDate/ModifiedDate/CodeModifiedDate/InterfaceModifiedDate/IsKnowHowProtected`；`PlcType.CreationDate/ModifiedDate/IsKnowHowProtected`；`PlcTagTable` **无**时间戳 |

## 5. 缺口与必要性评估

判定口径：**这份清单要服务什么**——(a) 导出/导入的完整性与审计；(b) 与版本控制/CI 配合的**变更检测**；
(c) 安全交付（本项目是 `isSafetyDevice=True`，有 54 个 Safety 块 + 1 个 F-OB）。

| # | 缺口 | 服务 | 必要性 | 理由 |
|---|---|---|---|---|
| 1 | **内容级、与时间戳无关的哈希**（或把 `sha256` 拆成"内容哈希"） | (b)(c) | **必须**（若要做变更检测） | 现在的 `sha256` 每次导出都变，等于没有变更检测能力；这是与 T 最实质的差距 |
| 2 | **分层指纹**（Comments / Interface / Events / Code / Properties） | (b)(c) | **值得**（高价值） | 它能回答"是接口变了还是只改了注释/事件"，直接影响是否需要重新编译、是否触发安全签名变化；但实现成本高（要按切片规范化 + 跨导出稳定），且 T 的算法不可复现，只能自研 |
| 3 | **安全签名**（`isSafetyDevice` / `fSignature` / `fBlockSignatures`） | (c) | **必须**（本项目语境） | 这是 Safety 交付的验收依据；本项目正好有 F 程序，且 F-OB 根本导不出来——签名是"安全程序有没有变"的唯一官方口径。API 现成 |
| 4 | **每对象时间戳 + `IsKnowHowProtected`** | (a)(b)(c) | **值得** | 便宜（遍历时顺手读），能与导入侧已有的 `ModifiedDate` 校验形成闭环；`isKnowHowProtected=True` 的对象导出/导入本就受限，提前标注可避免误判"导出失败" |
| 5 | **项目/设备元数据块**（作者、版本、最后修改人、订货号+固件、CPU 型号） | (a)(c) | **值得** | 审计与复现（"这份导出对应哪个 CPU 固件/哪个项目版本"）；`ProjectBase` 属性现成，成本极低 |
| 6 | **每对象相对路径**（+ 单一根） | (a)(b) | **值得** | manifest 现在写死绝对路径，目录一移动/换机器就失配；T 用"根 + 相对路径"是更耐用的设计 |
| 7 | **导出区间**（开始/结束时刻、耗时） | (a) | **可选** | 便于性能与"这一批是什么时候导的"；成本≈0 |
| 8 | 稳定 `id` | (b) | **可选** | 名称+组已能定位；只有在"对象改名后仍要追踪同一对象"时才需要，而 T 的 id 算法同样不可复现 |
| 9 | 每对象 `status`+`message`（替代 `failures[]`） | (a) | **不必** | 信息量与我现在的 `verified` + `failures[]` 相当，纯形状偏好；改形状反而破坏既有消费方 |
| 10 | `tiaIdentifier` | — | **不必** | 本样本里与 `name` 完全相同 |
| 11 | 复刻 T 的 `contentHash`/`fingerprints` 算法 | — | **不做** | 外部不可复现（见 §3），只能靠猜；自研语义哈希才能长期可控 |

### M 侧自身的一致性问题（与 T 无关，但顺带记录）

* 多类别导出时 `types`/`tag_tables` 也塞进 `blocks[]` 数组（靠 `category` 区分），键名与内容不符；
  顶层 `blockCount` 实际是"计划对象总数"。建议（若将来动手）改名为 `objects[]` / `objectCount`，
  并保留 `blocks` 作为兼容别名。
* `bytes`、`verified`、`declaredName` 是 M 相对 T 的**优势**：T 完全没有"写出后读回校验"这一环，
  它的 `status=Exported` 只表示"调用没抛错"。这一条应保留并写进对外说明。

## 6. 结论（一句话版）

* **同等信息、只是命名不同**：名字、组路径、类别、类型、编号、语言（T 的
  `folder/category/siemensTypeName/sourcePath/exportedFile` ≈ M 的 `category/simaticType/group/file`）。
* **T 有、M 真正缺且值得补**（按优先级）：**①内容级语义哈希 → ②安全签名 → ③每对象时间戳+know-how → ④项目/设备元数据 → ⑤相对路径 → ⑥导出区间**；
  其中 **分层指纹**价值最高但成本也最高（需自研规范）。
* **M 有、T 没有**：写出后**逐文件读回校验**（`verified`）、文件**字节数**、SHA-256、逐条失败清单、协议/生成者/导出选项/类别计数。
* **不必追**：复刻 T 的哈希算法、`tiaIdentifier`、把 `failures[]` 改成每对象 `status`。

## 7. 复核方式（任何人都能重跑）

```powershell
# 字段并集与非空率
$V = Get-Content '<T 的 metadata.json>' -Raw | ConvertFrom-Json
$V.components[0].PSObject.Properties.Name
$V.components | Where-Object { $_.fingerprints } | Select-Object -First 1 -ExpandProperty fingerprints

# 哈希假设检验（本例两个假设都是 False）
$e = $V.components | Where-Object name -eq 'R_Screen'
[Convert]::ToBase64String([Security.Cryptography.SHA256]::Create().ComputeHash(
  [IO.File]::ReadAllBytes((Join-Path $src ($e.exportedFile -replace '/','\'))))) -replace '\+','-' -replace '/','_' -replace '=',''
$e.contentHash
```

> 注：那句"T 未确认是哪个工具"是刻意的——上一轮我把这份导出误称为 TIA VCI，属无证据归因，
> 已更正（见 [decisions.md](decisions.md) D18）。本文只写可复核的观察，归因留空。
