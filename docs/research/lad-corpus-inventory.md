# LAD 语料盘点（阶段 0）

> 日期：2026-11-27 · 对应计划：[`docs/lad-understanding-plan.md`](../lad-understanding-plan.md) 阶段 0
> 方法：文本级正则普查，脚本 [`scripts/research/lad-census.ps1`](../../scripts/research/lad-census.ps1)。**只计数，不解析结构**；结构级分类在阶段 1/2 完成。
> 语料：reference `Sino_PEI`（1376 个 XML）与 pilot `PEI_1`（931 个 XML），均为 `0.2.5` 工作区下的 `source/` 导出。

## 1. 规模

| 指标 | reference | pilot |
|---|---|---|
| XML 文件数 | 1376 | 931 |
| CompileUnit 数 | 4550 | 4023 |
| Call（块调用）数 | 687 | 682 |
| `Negated`（取反引脚）数 | 2775 | 2681 |

`ProgrammingLanguage` 标签计数（reference）：LAD 4408、DB 640、SCL 490、F_LAD 129、F_DB 35、F_FBD 2；pilot：LAD 4018、DB 453、F_LAD 158、SCL 141、F_DB 43、F_FBD 2。

> 注意：`ProgrammingLanguage` 同时出现在块头和网络上，**不等于网络数**。网络数以 CompileUnit 数为准。

## 2. 连线标签（Wire 构成）

| 标签 | reference | pilot | 含义（待阶段 1 核实） |
|---|---|---|---|
| `NameCon` | 85226 | 81231 | 指向某个元素具名 pin 的端点 |
| `IdentCon` | 33640 | 32522 | 指向 Access（变量/常量）的端点 |
| `OpenCon` | 6927 | 6252 | 未连接端点（如未用的 ENO） |
| `Powerrail` | 4058 | 3735 | 能流左轨 |

连线规模约 12 万条（reference），是 AST 之外的主要结构量，**必须入库**。

## 3. 元素（Part 名称）分布

Top 项（reference）：

| 名称 | 数量 | 说明 |
|---|---|---|
| `Contact` | 12276 | 常开/常闭共用，取反靠 `Negated` 子元素 |
| `Coil` | 2154 | 普通线圈 |
| `O` | 1849 | OR 盒（`Card` 决定输入数） |
| `SCoil` | 1130 | 置位线圈 |
| `RCoil` | 1068 | 复位线圈 |
| `Move` | 1052 | 盒指令（EN/ENO） |
| `Eq` | 481 | 比较盒 |
| `Program_Alarm` | 317 | 报警盒 |
| `TON` | 235 | 接通延时定时器 |
| `Ne` / `Gt` / `Ge` / `Lt` / `Le` | 203 / 194 / 186 / 139 / 132 | 比较盒 |
| `PContact` | 196 | 上升沿触点 |
| `Calc` / `Add` / `Sub` / `Mul` / `Div` | 167 / 136 / 119 / 38 / 32 | 算术盒 |
| `NContact` | 62 | 下降沿触点 |
| `TONR` / `TOF` | 52 / 47 | 其它定时器 |
| `R_TRIG` | 27 | 边沿检测盒 |
| `Sr` | 26 | 置位复位触发器盒 |

Pilot 的分布结构一致（`Contact` 11628、`Coil` 1941、`O` 1803 为前三）。

**结论**：
1. 布尔元素（`Contact`、`Coil`、`SCoil`、`RCoil`、`O`、`PContact`、`NContact`）占绝大多数，串并联模型必须先覆盖它们。
2. **盒指令占比不小**（`Move`、比较盒、算术盒、定时器、`Sr`、`R_TRIG`，reference 中合计约 3266，不含 `Program_Alarm`）。它们有 EN/ENO 与数据 pin，不能只按"布尔输出"建模，否则串并联会把盒子当成普通触点，结构判断出错。
3. 仅覆盖 `Contact/Coil/O` 的第一版，预计能覆盖大多数网络，但盒指令网络必须单独标注，不能被误判为"结构正常"。

## 4. 变量作用域（Scope）

| Scope | reference | pilot |
|---|---|---|
| `LocalVariable` | 26962 | 20215 |
| `GlobalVariable` | 20947 | 16580 |
| `LiteralConstant` | 8736 | 5242 |
| `LocalConstant` | 984 | 108 |
| `TypedConstant` | 597 | 626 |
| `Call` | 823 | 197 |
| `SystemType` | 94 | — |
| `PredefinedVariable` | 7 | — |
| `Label` | 2 | 2 |

`LocalVariable` 与 `GlobalVariable` 合计占 Access 的绝大部分，符号解析必须区分两者（静态 FB 成员 vs PLC 全局变量）。

## 5. TemplateValue（盒子模板参数）

高频：`Card`（reference 3242 / pilot 3203，OR 盒与多输入盒的输入数）、`SrcType`（1679 / 1647）、`DestType`（43 / 32）、`time_type`（343 / 329，定时器时间类型）。

类型类参数（`src_type`、`dest_type`、`str_type`、`date_type`、`codedbool_type`、`value_type` 等）数量少，但**每个盒子必须带对应参数，否则无法得知其 pin 的数据类型**。

## 6. 对计划的修正与确认

- **确认**：串并联模型的第一版以布尔元素为主，盒指令单列为"需要 EN/ENO 语义"。
- **修正**：计划阶段 1 的元素目录（`ElementCatalog`）必须覆盖至少 `Move`、比较盒（`Eq/Ne/Gt/Ge/Lt/Le`）、`TON/TONR/TOF`、`R_TRIG`、`Sr`、`Calc/Add/Sub/Mul/Div` 共 17 类，否则它们会落入"generic"分支。
- **待阶段 2 验证**：`OpenCon` 的 6900 条在串并联中的含义（未用 ENO，还是未连接的输入）。

## 7. 未完成的部分

- 网络级分类（structured / unstructured）：需要阶段 1、2 的解析器，本阶段未做。
- 与 `logicStatements` 的对照：属于阶段 3，本阶段未做。

## 8. 复现

```powershell
pwsh -NoProfile -File scripts/research/lad-census.ps1 -Name reference -Root 'C:\Users\Ansel\Documents\dsh-automation-suite\0.2.5\reference\source\Sino_PEI'
pwsh -NoProfile -File scripts/research/lad-census.ps1 -Name pilot -Root 'C:\Users\Ansel\Documents\dsh-automation-suite\0.2.5\pilot\source\PEI_1'
```

脚本输出与本文档数字一致（以 2026-11-27 的导出为准；导出变化后数字会随之变化，需重新普查）。
