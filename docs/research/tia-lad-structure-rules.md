# TIA LAD 结构规则实验（M0）

> 状态：**协议已写，待执行** · 2026-11-27
> 对应计划：[`docs/lad-understanding-plan.md`](../lad-understanding-plan.md) 第 5 节（阶段 2 的前置）。
> 目的：确定 TIA 接受哪些 LAD 拓扑。结论直接决定 `SeriesParallelReducer` 的判定条件。

---

## 1. 要回答的问题

| 编号 | 用例 | 要回答 |
|---|---|---|
| E1 | 线圈后面还接着触点（同一条路径） | 线圈是否只能位于分支末端 |
| E2 | 分支里再分支，末端挂线圈 | 嵌套分支是否合法 |
| E3 | 同一个位在同一网络里被 `S` 和 `R` 同时写 | 是否合法、是否告警 |
| E4 | 同一个触点输出既驱动线圈，又驱动后面的触点（扇出） | 扇出的合法形态 |

另外保留一个**对照用例 C0**（单触点单线圈），必须导入成功。C0 失败说明实验环境有问题，本轮结果全部作废。

## 2. 执行环境（前置条件）

| 项 | 要求 | 当前状态 |
|---|---|---|
| TIA Portal V17 | 已安装，许可可用 | 已安装（`Portal V17` 目录存在） |
| 测试项目 | `C:\Users\Ansel\Documents\Automation\V17\PEI_SinoARP_SWT2\PEI_SinoARP_SWT2.ap17`（**只读源**） | 存在 |
| 实验工作区 | **新建**，一个工作区只管一个工程，不能复用 pilot 工作区 | 待建：`C:\Users\Ansel\Documents\dsh-automation-suite\lad-m0` |
| 工具会话 | 必须是装有 `dsh-tia-openness-v17-min` 与 `dsh-engineering-context` 的 profile（即 `dsh-automation-suite` 那套，见仓库 AGENTS §6） | 当前桌面 profile **没有** TIA 插件，需切换 |
| TIA 窗口 | 可见窗口（`with_window=true`，默认），便于人工确认 | 当前无 TIA 进程 |

### 2.1 建副本（只做一次）

源工程**不得被修改**。副本通过 `create_engineering_project` 生成，不手工复制项目目录：

```jsonc
create_engineering_project({
  "source_project": "C:\\Users\\Ansel\\Documents\\Automation\\V17\\PEI_SinoARP_SWT2\\PEI_SinoARP_SWT2.ap17",
  "dry_run": false
})
```

副本落在 `lad-m0\tia\lad-m0\`。之后所有实验都只对副本操作。

### 2.2 源未被改动的核对

`PEI_SinoARP_SWT2.ap17` 的修改时间与建副本前一致（TIA 打开时会写临时文件，核对时排除 `IM\SearchIndex\segments_*` 与 `TMP\StandardMotionControl\cache.tmp`，见仓库 AGENTS §7）。

## 3. 实验用的网络（SimaticML 写法）

每个用例是一个独立的 **FC**，名字固定为 `M0_E1`…`M0_E4`、`M0_C0`。每个文件只含一个块，导入失败只影响该块，不会像多文件导入那样产生部分写入（见 `Operations.cs` 1187–1194 的问题）。

网络的图形描述（触点 = `Contact`，线圈 = `Coil`/`SCoil`/`RCoil`，`O` = OR 盒，`Negated` 表示常闭）：

**C0（对照，必须通过）**
```
L1 ─[ A ]─(=) Q0
```

**E1（线圈后接触点）**
```
L1 ─[ A ]─(=) Q1 ─[ B ]─(=) Q2
```
同一条路径上，`Q1` 线圈之后又接了触点 `B`，再接线圈 `Q2`。

**E2（分支里再分支，末端挂线圈）**
```
L1 ─[ A ]─┬─[ B ]─┬─(=) Q1
          │       └─(=) Q2       ← 这两个线圈都在第一层分支 B 的分支末端
          └─[ C ]──(=) Q3
```
要求：分支 B 内部又分成两路，各自末端挂线圈；分支 C 与之并联。

**E3（同一位被 S 和 R 写）**
- E3a（同一网络）：
```
L1 ─[ A ]─(S) M0_BIT
L1 ─[ B ]─(R) M0_BIT
```
- E3b（不同网络）：网络 1 为 `(S) M0_BIT`，网络 2 为 `(R) M0_BIT`，各自为独立 CompileUnit。

**E4（扇出）**
```
L1 ─[ A ]─┬─(=) Q1
          └─[ B ]─(=) Q2
```
`A` 的输出同时驱动线圈 `Q1` 与触点 `B`。

> 变量名用 `M0_A`、`M0_B`…等**不存在于工程中的占位名**（在 FC 里作为接口的 Input 声明），不引用工程里的真实 I/O，避免副作用。

## 4. 每个用例的步骤

对每个用例（C0 先做）：

1. 按第 3 节写出 `M0_<编号>.xml`（SimaticML `SW.Blocks.FC`，只含一个 CompileUnit 或按 E3a/E3b 的要求含两个）。
   - 写 XML 时**先参照**仓库里已导入成功的样例：`engine/fixtures/FC_LAD_SimulateCylinder_Call [FC1].xml`（有触点、线圈、连线的完整 FlgNet）。
   - UId 在一个网络内必须唯一：Part、Access、Wire 共享一个命名空间（见阶段 1 的说明）。
2. `import_blocks`（单文件，`dry_run=false`，`import_options=override`，`mirror_groups=true`）。
   - 记录返回的 **Committed**、**Applied changes**、**failure message** 原文。
3. 导入成功：`compile_plc`，记录 `Compile state` 与该块的 error/warning 原文。
4. 导入失败：记录 TIA 报错原文（含 "at line number" 与 "UId" 相关文本）。
5. 导出回读：`export_blocks` 该块，确认导出成功且 Openness 没有拒绝。失败也要记录（"Inconsistent" 或 "refused" 都是结果）。
6. 把本用例结果写入第 6 节的表。

**不要**在一个用例失败后马上修改 XML 再试：每个用例只导入一次原始写法。若怀疑是 XML 写法本身的错误（例如 UId 冲突），单独记为"写法问题"，并用 C0 的写法作对照排除。

## 5. 判定与对应的归约规则

| 结果 | 归约规则 |
|---|---|
| E1 通过 | 线圈后允许继续接元素。阶段 2 的 `SeriesParallelReducer` 不把"线圈后接元素"视为 `unstructured` |
| E1 失败 | 线圈必须是分支末端。`SeriesParallelReducer` 将违反的网络标为 `unstructured`，原因写 "coil-not-terminal" |
| E2 通过 | 嵌套分支归约为 `Parallel(Series(... Parallel(...)))`，正常处理 |
| E2 失败 | 嵌套分支只允许一层，更深的标为 `unstructured` |
| E3a 通过 | 同网络 S 与 R 同一位合法，`flg_writes` 中两行都记录；时序标注按"后写者胜" |
| E3a 失败 | 同网络不允许同位双写；E3b 通过则只能跨网络；记入 `flg_writes` 时仍照实记录 |
| E4 通过 | 扇出是合法形态，rung 树里用 `Branch` 节点表示 |
| E4 失败 | 扇出不合法；但 `FlgNetworkGraph` 的 pin 级连线仍照实记录，只在归约时标 `unstructured` |

## 6. 结果记录表（执行后填写）

| 用例 | 导入 | 编译 | 导出回读 | TIA 原始报错（节选） | 对应规则结论 |
|---|---|---|---|---|---|
| C0 | ✅ | ✅ 0 error | ✅ verified | — | 对照（通过） |
| E1 | ✅ | ✅ 0 error | ✅ verified | — | 线圈后可继续接元素（普通线圈） |
| E2 | ✅ | ✅ 0 error | ✅ verified | — | 嵌套分支合法 |
| E3a | ❌ 回滚 | 未执行 | 未执行 | `connection with UId '22' ... used multiple times at the cables` | 写法问题，**未决** |
| E3b | ✅ | ✅ 0 error，无相关告警 | ✅ verified | — | 同一位跨网络 S/R 合法 |
| E4 | ✅ | ✅ 0 error | ✅ verified | — | 扇出合法 |

原始返回与导出回读：执行工作区 `lad-m0\m0-raw\`、`lad-m0\m0-raw\exports\`。

结果另存为 `docs/research/tia-lad-structure-rules.md` 第 7 节的记录，并附每个导入返回的原文。

## 7. 实验记录（执行后追加）

**执行**：2026-11-27 12:44–12:55，执行会话在 `lad-m0` 工作区完成，全文见 `lad-m0\m0-results.md`。

**规划会话的独立核对（13:10）**：
- 源工程 `PEI_SinoARP_SWT2.ap17`：7736 字节，修改时间 2026-10-14 10:08:06，与建副本前一致。
- E1 导出 `M0_E1.xml` 中的结构与结果文件描述一致：`Coil 26 out → Contact 27 in`，无 `O` 节点，无扁平化。

**结论**

- **E1 通过**：线圈后可以继续接元素。仅对普通线圈（`Coil`）成立。
- **E2 通过**：嵌套分支合法，不限一层。
- **E3b 通过**：同一位的 S 与 R 分处不同网络，合法且无告警。
- **E4 通过**：一条 Wire 挂多个目标即为扇出，合法。
- **E3a 未决**：失败原因是写法错误，不是结构判定。`M0_BIT` 被写成一个 Access 却接到两个线圈的 `operand`，TIA 拒绝"同一连接被复用"。按协议没有改写重试，因此不能作为结论。

**本轮的覆盖范围与局限**（重要）

本轮只验证了普通线圈、普通触点、OR 盒之外的简单分支。下列元素**没有**测试：

1. 置位/复位线圈（`SCoil`/`RCoil`）后面还接元素。
2. 取反触点（`Negated`）出现在分支或串联中。
3. 盒指令（`Move`、比较、`TON` 等）。
4. 同一网络内的 S/R 双写（E3a 未完成）。

**对早期失败的影响**：第 4 轮的 Step 6 曾被拒绝（"not supported in this language version"）。那一网络的线圈来自扇出节点，而 E4 证明扇出本身合法；它也包含普通线圈末端，而 E1 证明线圈后接元素合法。因此早先的两个怀疑都被排除，真正的原因很可能是 `RCoil` 位于分支中间，或与取反触点的组合。这一点仍需验证，见下一节。

## 8. 后续实验建议（待决定）

| 编号 | 用例 | 目的 |
|---|---|---|
| E5 | `RCoil`（或 `SCoil`）的 `out` 接一个后续触点，位于分支中间 | 检验 Step 6 失败的最可能原因 |
| E6 | 取反触点（`Negated`）位于分支内，后接线圈 | 检验取反触点在分支中的合法性 |
| E3a' | 同一网络内同一位的 S 与 R，各自使用独立的 `Access` 节点 | 补全 E3a，判定同网络双写 |

建议由执行会话继续做这三项（同一工作区、同一副本、同一写法基准），结果仍写入 `m0-results.md` 的增补节。规划会话据此确定 `SeriesParallelReducer` 的最终规则。

### 8.1 补充用例的网络设计（执行前读完）

每个用例仍是一个独立的 FC，每个文件只导入一次。新用例用新块名，**不要**复用已失败的 `M0_E3a` 名字：E3a' 的块名为 `M0_E3a2`。

**写法约束**（都来自 E3a 与 E4 的结果）：

1. 一个 `Access` 节点只能作为一条 `Wire` 的源。同一操作数被多处使用时，每处各自一个 `Access`（UId 不同，变量名相同）。
2. 扇出的写法是：**一条 `Wire` 的源 `IdentCon`/`NameCon` 挂多个目标**。不要用两条 `Wire` 共用同一个源。
3. 取反触点：`<Part Name="Contact" UId="n"><Negated Name="operand" /></Part>`，即 `Negated` 是 `Part` 的子元素。
4. 所有 UId（Part、Access、Wire）在同一个网络内必须唯一。

**E5（RCoil 位于分支中间）**

```
L1 ─[ A ]─┬─(R) Q1 ─[ B ]─(=) Q2
          └─[ C ]─(=) Q3
```

- `Q1` 是 `RCoil`，它的 `out` 接触点 `B`，`B` 再接线圈 `Q2`。
- 目的：`RCoil` 后面还接着元素，并且位于分支中间。
- 若要测 `SCoil`，另建 `M0_E5s`，结构完全相同，只把 `RCoil` 换成 `SCoil`。

**E6（取反触点）**

网络 1（串联）：
```
L1 ─[/ A ]─[ B ]─(=) Q1
```
网络 2（分支内）：
```
L1 ─[ C ]─┬─[/ D ]─(=) Q2
          └─[ E ]─(=) Q3
```

- `/` 表示取反，用 `Negated` 子元素表达。
- 同一个 FC 里两个网络，分别是两个 CompileUnit。

**E3a'（同一网络内同一位被 S 和 R 写，两个 Access 节点）**

```
L1 ─[ A ]─(S) M0_BIT_s
L1 ─[ B ]─(R) M0_BIT_r
```

- `M0_BIT_s` 与 `M0_BIT_r` 是**两个不同的 `Access`**，它们的变量名都是 `M0_BIT`，接口里只声明一次（`Output`）。
- 这是 E3a 失败的写法修正，不是重试。结果记入增补节，标注为 E3a'。

**失败的处理**：每个用例导入失败就如实记录 TIA 原文，不修改 XML 重试。若失败，请同时记录该网络的 XML 写法（方便区分写法问题与结构问题）。

### 8.2 增补结果的交接

执行会话在 `m0-results.md` 末尾新增"增补（E5、E6、E3a'）"一节，格式与前面相同，并追加结论摘要。原始返回仍放在 `m0-raw\`，导出回读放在 `m0-raw\exports\`。

### 8.3 增补结论（2026-11-27 13:23，规划会话核对）

执行结果见 `lad-m0\m0-results.md` 增补节。规划会话已核对：源工程未改动（7736 字节，2026-10-14）；三组原始文件与导出齐全；E5 导出中 `Wire 35` 为 `Contact 27 out → RCoil 28 in + Contact 31 in`，`Wire 37` 为 `RCoil 28 out → Contact 29 in`。

- **E5 通过**：`RCoil` 位于分支中间且后接元素，合法。
- **E6 通过**：取反触点串联与分支内均合法，`Negated` 原样保留。
- **E3a' 通过**：同网络同位 S/R 双写合法且无告警。E3a 的未决由此补齐（写法问题已排除）。

**累计结论（M0 全部）**：普通线圈、置位/复位线圈、取反触点、扇出、嵌套分支、同位双写（跨网络与同网络）均合法。阶段 2 的归约不再需要"线圈只能在分支末端"与"取反/置位线圈受限"等规则。

**仍未验证的部分**（这决定 Step 6 的原因还没找到）：

1. 盒指令（`Move`、比较、`TON` 等）位于分支中间，即 EN/ENO 与布尔分支的组合。
2. O 盒合流之后再接元素。M0 只测了分叉（扇出），没有测合流。工程现有导出中的 O 盒合流（如 `131` 网络）是能导入的，但那是 TIA 生成或他人写的，不是本次实验的写法。

建议再做一个小批次：E7（O 盒合流后接线圈）与 E8（`Move` 盒位于分支中间，ENO 接后续触点）。若不做，阶段 2 对盒指令网络默认标为 `unstructured`，原因写 `box-in-branch-untested`。这对读侧理解的影响有限，但会留下一批不可归约的网络。

## 9. 结果交接（执行会话 → 规划会话）

执行会话在实验工作区里完成，规划会话（本计划所在的会话）负责把结论落回仓库。两者之间用**工作区内的文件**交接：

1. 执行会话把全部结果写入 `C:\Users\Ansel\Documents\dsh-automation-suite\lad-m0\m0-results.md`，结构与第 6、7 节一致。
2. 每个用例的 `import_blocks`、`compile_plc`、`export_blocks` 返回文本**原样**保存到 `lad-m0\m0-raw\<用例编号>-<步骤>.txt`，结果文件里只引用路径，不重复粘贴大段文本。
3. 结果文件末尾写一段"结论摘要"：每个用例一行，格式为 `E1: 通过/失败/未决 — 依据：…`。
4. 执行会话完成后在对话里告诉用户"M0 完成"。用户再把这句话转给规划会话，规划会话读取 `m0-results.md` 与 `m0-raw/`，把结论写入本文档第 6、7 节，并据此修改 `SeriesParallelReducer` 的判定规则。

**为什么不直接写仓库文件**：执行会话的文件写入通常限制在它自己的工作区内。仓库文件由规划会话统一修改，也便于做认领与审阅。

**异常处理**：若任何用例导入后 TIA 出现 `Inconsistent` 或副本工程无法保存，执行会话应停止后续实验，把现场状态写入 `m0-results.md` 的"异常"一节，并附上 `project_status` 的输出，不要自行修复后继续。

## 8. 注意事项

- 只对副本工作区 `lad-m0` 的工程操作。源工程路径只读。
- 每次导入后不要保存副本以外的任何工程。
- TIA 进程若由其他会话占用（如 pilot 会话的控制器），先确认没有并发写入同一个工程，再开始。
- 结论以 **V17 实测** 为准。TIA 的上游文档是 V21 语义，不能用来代替本实验（见 `skills/tia-openness` 的版本口径说明）。
