# TIA 项目多语言文本批量转换：技术方案评估

> **评估对象**：给 `dsh-automation-suite` 增加一个能力——把 TIA Portal 项目里的
> 项目文本（程序块标题/注释、网络标题/注释、标签注释、UDT 注释等）**批量译成目标语言**
> （典型场景：项目只有英文，切到中文后大量文本为空白，需要补 `zh-CN`）。
>
> **评估日期**：2026-11-02。
> **评估依据**：本机 TIA Portal V17 / Openness V17、TIA 自带帮助与 Openness 手册、
> 仓库现有插件代码、以及 `SWT2_PEI_1026_Night` 的一份真实导出物（1,376 个 XML）。
> **本文只做评估，没有改代码。** 文中的"建议"都尚未实现；"待验证"项见 §5。

---

## 0. 结论（给决策者）

| 问题 | 结论 |
|---|---|
| **能不能做？** | **能。** TIA 官方就为"翻译项目文本"预留了 XLSX 导出/导入通道，本仓库的 TIA 插件已经封装了 `project_texts` 与 `project_languages` 两个工具。 |
| **推荐哪条路？** | **A. Project texts XLSX 往返**：导出 → 只填目标语言列 → 导回。**不需要新增 Openness 操作、不需要改 C# 控制器。** |
| **逐对象 API 行不行？** | **不能作为主方案。** `MultilingualTextItem` 只能改"已存在的语言项"，Openness **没有创建缺失语言项的 API**；激活语言是否会自动生成空 item 需 Q3 验证，但即便会，逐对象遍历仍是上千次调用（§3.2）。 |
| **规模有多大？** | 真机导出 V17 项目文本：**User Texts 33,045 行**，其中 **8,156 行"源有值、目标为空"（`en-GB` 口径，需要补）**，**6,432 行已有中英文本**，**18,404 行两端都空**（占位行）。补译量集中在块注释 7,501 行、标签注释 446 行；按多源合并后需补行数还会增加（§2.3）。 |
| **最大风险是什么？** | 不是"翻不出来"，而是：**导入不可回滚**、XLSX 空值/行身份语义未验证、以及仓库里的 `project_texts` **导入路径仍无真机验收**（导出已由 2026-11-02 实测补上，§2.3）。 |
| **要多久？** | **spike 1–2 天**（必须先做，见 §5）；**v1 约 3–5 周 / 16–25 人天**（1 人，含测试与真机验收）；只做"能跑通的最小闭环"约 **1.5–2 周**（§7）。 |
| **第一步做什么？** | Q1（格式）已在 2026-11-02 真机验证；接下来做 Q2–Q5（空值语义、能否新建目标语言项、行身份、覆盖范围）的 spike，再排实现（§5）。 |

一句话：**可行性高、技术路线清楚，但要把"导入的不可回滚"和"未验证的 XLSX 语义"当成项目的第一等风险，而不是实现细节。**

---

## 1. 需求与技术前提

### 1.1 用户场景

一个 TIA 项目以英文为默认/参考语言；程序块的标题与注释、网络（段落）注释、标签注释等
都只有英文。把项目语言切到中文后，这些输入框是**空白**的；用户希望一次性把整批文本
译成中文，而不是逐块打开、逐条粘贴。

"转换"在这里要明确为两件事：

1. **补齐目标语言文本**（本评估的对象）：给已有文本增加 `zh-CN` 版本；
2. **切换项目语言**（不是本评估的重点）：改 editing/reference language，已有工具
   `project_languages` 就能做，不需要翻译。

### 1.2 TIA 的语言模型：为什么切中文会是空白

TIA Portal 的项目语言有三个相关概念（TIA 帮助 "Project text basics"）：

- **Project languages（项目语言）**：项目里启用的语言集合；
- **Editing language（编辑语言）**：新输入的文本写进哪种语言；
- **Reference language（参考语言）**：翻译时的参照列；在 "Tasks > Languages & Resources"
  里显示，供对照输入。

关键行为（TIA 帮助 "Translating project texts using reference texts" 原文）：

> After changing the editing language, all texts are shown in input boxes in the new editing
> language. **If there is not yet a translation available for the newly set language, the input
> boxes are empty.**

也就是说，**没有目标语言文本项时不会自动回退显示参考语言**，输入框就是空的——这正是
用户看到的现象。要消除空白，必须为目标语言**实际写入**文本项，而不是改显示设置。

### 1.3 目标与非目标

**目标**

- 在 DSH 会话里，用一条工作流把项目文本批量译成目标语言，并**可验证、可报告、可回滚**；
- 覆盖 PLC 程序块/网络/标签/UDT 等"用户文本"；
- 术语一致（术语表）、不翻译标识符与占位符、保留换行；
- 导入后能证明：目标语言列有值、其他语言列没被改、默认语言没被改、工程能编译。

**非目标（v1）**

- 不翻译程序逻辑、变量名、块名、库名；
- **不翻译 F 块（安全程序）**：只按 `programmingLanguage=F_*` 识别并排除；**不用组名**
  （组名是用户任意命名的，没有规则）；整块不动；
- 不主动改项目的 reference language（除非用户明确要求）；
- 不做 HMI 画面布局/图形文本的全量翻译（可作为后续扩展）；
- 不替代人工审校。

---

## 2. 现状盘点

### 2.1 仓库里已经有什么

TIA 插件（`packages/dsh-tia-openness-v17-min`）已经暴露了两个关键工具：

| 工具 | 作用 | 现状 |
|---|---|---|
| `project_languages` | 列出/修改项目语言：`active_languages` 增删、`editing_language`、`reference_language` | 有；写路径非事务（`docs/decisions.md` D22 相关段落） |
| `project_texts` | 把项目文本导出成 `.xlsx`，或从 `.xlsx` 导入 | 有；**导入不包事务、无法回滚**；没有 dry-run |
| `update_project` | 改项目注释等 | 有，但只写"已存在的语言项" |
| `WriteMultilingualText`（内部） | 按 editing language 写一条 `MultilingualText` | 只能写已有 item，**不能新建 item**（见 §3.2） |

相关代码位置：

- `packages/dsh-tia-openness-v17-min/src/tools.ts:1520` —— `project_texts` 工具定义；
- `packages/dsh-tia-openness-v17-min/controller/OpennessHost.Project.cs:811` —— `ExportProjectTexts`；
- 同文件 `:844` —— `ImportProjectTexts`；
- 同文件 `:738` —— `WriteMultilingualText`；`:698` 与 `:735` 的注释明确写着
  "a language that carries no comment item yet cannot be created through this API"。

**语言相关接口清单**（模型可见工具 + 其背后的 Openness 面）：

| 接口 | 语言相关点 | 读/写 |
|---|---|---|
| `project_languages` | supported / active / editing / reference 四种语言集合 | 读 + 写（启用/停用/切换） |
| `project_texts` | XLSX 导出/导入，按 source/target culture 选列 | 导出读；导入写 |
| `project_info`（`sections` 含 `comment`、`languages`） | 项目注释按语言列出；语言目录/活动/编辑/参考 | 读 |
| `update_project`（`comment_language` + `comment_text`） | 按语言写项目注释；只写已存在的 item | 写 |
| `write_tags`（`comment`） | 标签/常量注释，多语言；按 editing language 写 | 写（仅已有 item） |
| `list_plc_objects` | 标签/常量/软件单元注释；`CommentText` 取首个非空文本 | 读 |
| `export_blocks` / `import_blocks` | SimaticML `<MultiLanguageText Lang="...">`；块/网络/标签注释随 XML | 读 / 写（整块） |
| `export_hardware_config` / `hardware_inventory` | `include_comments`：设备/模块的多语言注释 | 写文件 / 读文件 |
| `create_project`（`comment`） | 新建工程时的项目注释（写入默认语言） | 写 |
| `set_block_attributes` | 通用属性写；`Comment`/`Title` 能否写取决于 Openness 属性元数据，**不是语言专用接口** | 写（不确定） |

底层 Openness 面：`LanguageSettings`、`Language`、`MultilingualText`、
`MultilingualTextItem`（`Language` 只读、`Text` 读写）、`ProjectTextResult`、
`ProjectBase.ExportProjectTexts/ImportProjectTexts`；SimaticML 的 `MultiLanguageText` 元素。

### 2.2 Openness 侧的两个硬事实

#### 事实一：XLSX 是官方翻译通道，但有明确限制

Openness V17 手册（本机 `TIAPortalOpennessenUS` 帮助，页 "Export of project texts" /
"Import of project texts"）与 API 文档（`Siemens.Engineering.xml`）：

```csharp
// ProjectBase
void ExportProjectTexts(FileInfo path, CultureInfo sourceLanguage, CultureInfo targetLanguage);
ProjectTextResult ImportProjectTexts(FileInfo path, bool updateSourceLanguage);
```

导出的就是翻译用的 `.xlsx`；导入时 `updateSourceLanguage=false` 表示**不更新参考语言列**。
手册列出的限制（原文要点）：

- 导出的文本**只能导回导出它的那个项目**；
- 只能导入到**项目里已启用**的语言；
- **只有原本存在的文本才能导回**；如果导出后文本被删除或重建，该行导入会失败；
- 多语言文本**跟随父对象**导出/导入，不能单独导出；
- 导入/导出**不能在 Transaction 内做**（仓库的 `project_texts` 因此没有 `committed`，也无法回滚）。

TIA 帮助的 "Application examples for multilanguage projects" 还给了一个完整例子：
德语项目导出 → 外部译成英语 → 导入后 "All texts are now available in German and English"。
这说明**导入可以补齐原本不存在的目标语言文本**（本方案成立的关键；V17 上仍需 Q3 复核）。

> 结论：这是"批量写目标语言"的**官方、覆盖最全的批量通道**；但它的身份绑定和不可回滚，
> 决定了工作流必须"同一会话内导出→导入 + 导入前归档"。

#### 事实二：逐对象 API 不能创建缺失的语言项

`MultilingualText` / `MultilingualTextItem` 的模型是（Openness 帮助 "Accessing and
enumerating multilingual texts"）：

- `MultilingualText.Items` 是 `MultilingualTextItemComposition`，用 `Find(language)` 找 item；
- `MultilingualTextItem.Language` 只读，`Text` 可读写；
- 手册只给了"找到 item 后写 `Text`"的示例，**没有提供"新增 item"的方法**；
- 激活语言是否会**自动生成空 item**，手册没有说明——这是 Q3 要验证的点；
- 仓库代码的注释也直接写死了这个结论（`OpennessHost.Project.cs:698,735`）。

所以，对"中文当前完全空白"的场景，**逐对象 API 没有可靠的新建路径**；它只能用于
"目标语言项已存在、只是内容要改"的情况（例如重新翻译、修正某条译文）。

### 2.3 真实项目上的文本规模（实测）

为避免拍脑袋，本文对仓库外的一份真实导出物做了只读统计：

- 路径：`C:\Users\Ansel\Documents\dsh-automation-suite\SWT2_PEI_1026_Night\source\Sino_PEI`
- 来源：`create_engineering_project` 于 2026-10-26 导出的 Source 树（1,376 个 XML，
  manifest 记录 1 个失败项）；不是当前源项目的实时状态，只作量级参考。
- 方法：正则统计所有 XML 里的 `<MultiLanguageText Lang="…">`。

| 指标 | 数值 |
|---|---|
| XML 文件 | 1,376 |
| 含多语言文本的文件 | 464 |
| `<MultiLanguageText>` 项总数 | **6,415** |
| 语言种类 | `en-GB`、`fr-FR`、`en-US`、`de-DE` |
| `zh-CN` 项 | **0** |

按语言拆分：

| 语言 | 项数 | 去重文本数 | 字符数 | 出现文件数 |
|---|---:|---:|---:|---:|
| `en-GB` | 2,955 | 2,137 | 87,691 | 280 |
| `fr-FR` | 1,784 | 1,140 | 50,847 | 190 |
| `en-US` | 1,516 | 803 | 85,255 | 170 |
| `de-DE` | 160 | 131 | 7,249 | 11 |
| `zh-CN` | 0 | 0 | 0 | 0 |

按块语言拆分（只统计含多语言文本的文件）：

| 程序语言 | 文件数 | 文本项 |
|---|---:|---:|
| SCL | 140 | 1,662 |
| LAD | 132 | 1,450 |
| DB | 41 | 882 |
| F_LAD | 6 | 30 |
| F_DB | 4 | 70 |
| F_FBD | 2 | 38 |
| 其他（标签表/类型等） | 139 | 2,283 |

**这组数字说明三件事**：

1. **中文不是"完全缺失"**：XML 导出物里没有 `zh-CN` 项，但 V17 的 XLSX 实测显示项目里
   已有 **6,485 行中文**（主要在 HMI/报警/文本列表；PLC 块注释只有 139 行有中文）。
   两份材料是不同快照/不同范围，**以 XLSX 为准**；
2. **量级可控**：V17 XLSX 33,045 行里，真正要补的是 **8,156 行**（源有值、目标空）；
3. **SCL 的块内注释也走多语言文本**（1,662 项），不是只有 LAD 的网络注释。

> 注意：XML 只导出"显式设置过"的语言；这里的 0 个 `zh-CN` 不能 100% 证明项目里没有
> 中文占位项。项目副本与当前源项目也可能有差异；实现前应在目标项目上重新统计一次。

#### V17 真机导出实测（2026-11-02，项目副本）

用控制器直接对 `SWT2_PEI_1026_Night` 副本执行 `OpenProject` + `ProjectTexts(export)`，
源 `en-GB`、目标 `zh-CN`。结果文件
`temp/tia-texts/ProjectTexts-2026-11-02T14-28-14-407Z.xlsx`（4,108,066 字节）：

| 项 | 实测 |
|---|---|
| Sheet | `User Texts` **33,045 行**；`System Texts` 1,063 行 |
| 列 | **22 列**：`Category` `ViewPath` `Internal ID` `Substitutions` `en-GB*` `zh-CN` `ref="0"`…`ref="15"` |
| `Internal ID` | 33,045 个，**全部唯一** |
| 源列有值 | 14,588 行 |
| 目标列有值 | 6,485 行 |
| **源有值、目标空（要补）** | **8,156 行** |
| 源空、目标有值 | 53 行 |
| 两端都空 | 18,404 行 |

补译量按 `Category`：

| Category | 总行 | 需补 | 已有 |
|---|---:|---:|---:|
| `<BlockCommentCategoryData>` | 10,175 | **7,501** | 139 |
| `<TagCommentCategoryData>` | 453 | 446 | 4 |
| `<HwcnCommentTextCategoryData>` | 83 | 81 | 0 |
| `<HMI runtime>` | 675 | 100 | 562 |
| `<HMI screen>` | 3,722 | 8 | 3,376 |
| `<TextListTextCategoryData>` | 749 | 5 | 743 |
| `<FormattedUserAlarmTextCategory>` | 16,962 | 3 | 1,482 |
| 其余 5 类 | 226 | 12 | 126 |

**量级**：8,156 行待补（`source=en-GB` 口径），去重后 **5,527 条**、**274,760 字符**
（唯一文本 192,805 字符）；按 100 条/批约 56 批。按当前 LLM 价格，输入约 5 万 token、
输出约 7 万 token，成本很低。

> 8,156 是**只导 `en-GB`** 的口径。按多源合并后，"源有值、目标空"的行会更多：
> 例如 `LCCF_CipClient` 的块注释只在 `en-US` 有文本，`source=en-GB` 里是空行；
> 这类文本需要 `en-US`/`fr-FR`/`de-DE` 的导出才能看到。具体增量需按第二轮导出统计。

**重要观察**：

- V17 API 的导出**只给 source + target 两个语言列**（加 16 个 `ref=` 列），
  不是 V14 样本里的"所有已激活语言列"；列映射不能再照抄旧样本；
- 源列里**混有法语**（例如 `CT trigger ... data même si evac MDV005`）：
  编辑语言是 `en-GB`，但作者用英/法混写。翻译前要做语言识别，或再导出一次
  `source=fr-FR` 作为补充源（按 `Internal ID` 合并）；
- `ViewPath` 末尾能区分文本类型：`...\Network N\Title`（网络标题）、
  `...\Network N\Comment`（网络注释）、`...\Comment`（块/标签注释）、
  `PLC alarm text lists\...\Text`（报警文本）；
- 块注释 7,501 行是主战场；标签注释几乎全空（446/453）；HMI/报警大部分已有中文。

#### 块标题/注释在 XLSX 里的位置（实测）

`<BlockCommentCategoryData>` 不只有"块注释"；按 `ViewPath` 末尾分：

| ViewPath 末尾 | 行数 | 需补 | 已有 |
|---|---:|---:|---:|
| `\Block title` | 334 | 172 | 40 |
| `\Block comment` | 164 | 31 | 8 |
| `\Network N\Title` | 4,173 | 4,004 | 47 |
| `\Network N\Comment` | 351 | 330 | 0 |
| `\Title of the PLC data type` | 24 | 0 | 1 |
| `\Comment on PLC data type` | 25 | 2 | 0 |
| 其他（接口/操作数/成员注释，末尾是成员名） | 5,104 | 2,962 | 43 |

示例：块 `R800_CU4_UpdateTool_A`

- `...\R800_CU4_UpdateTool_A\Block title` = ` INTERFACE  ANIMATION  -> CU4`
- `...\R800_CU4_UpdateTool_A\Block comment` = `FUNCTION ALARMS UPDATE TOOLING...`
- 同一块的 `Network 1..36\Title/Comment` 也在；XML 里对应
  `<MultilingualText CompositionName="Title|Comment">` 的 `<Culture>en-GB</Culture>` 文本，内容一致。

**但有一个关键限制**：V17 XLSX 只有**一个**源语言列。若某块的标题/注释只存在于
`en-US`/`fr-FR`/`de-DE`，在 `source=en-GB` 的导出里这一行会**存在但源列为空**。
实测例子：

- 块 `LCCF_CipClient` 的 `Block comment` 只在 `en-US` 有文本；`source=en-GB` 导出里
  该行 `en-GB*` 为空、`zh-CN` 为空；同一块的 XML 里能看到 `en-US` 的文本。
- `LGF_Frequency` / `LGF_Impulse` 等的 `Block comment` 只在 `de-DE` + `en-US` 有文本。

所以：

1. **块标题/注释不需要 XML**，XLSX 里有行；
2. 但要把"只存在于其他语言"的文本也补上，应**按多种源语言各导一份**
   （至少 `en-GB`、`en-US`、`fr-FR`、`de-DE`），按 `Internal ID` 合并，取非空源；
3. 若只导 `en-GB`，会误以为这些块"没有注释"。

### 2.4 现有验证状态：这是排期最大的不确定性

`packages/dsh-tia-openness-v17-min/docs/VERIFICATION-PLAN.md:130` 把 `project_texts`
标为 **"高风险，先备份工程"**，而其验收项到本文写作时仍未勾选：

```
☐ 2.15 导出文件可读
☐ 2.16 导入的 state 与结果文件内容可解释
☐ 2.17 导入后 TIA 里文本确实变了
```

（其中 **2.15 已由本文 2026-11-02 的实测补上**：能导出、能被 openpyxl 读出、列布局见 §2.3；
2.16/2.17 仍未做。）

文档里还明确写了两条：

- `ImportProjectTexts` 只返回 `State` 与 `Path`，而 `Path` 的语义手册没说明
  （可能是结果日志，也可能是别的）；
- 导入刻意不包事务，手册明确禁止事务内做 ProjectText Import/Export。

**这意味着：导出格式已在 2026-11-02 真机验证（§2.3），但导入、空值语义、行身份仍未验证。**
评估可以给出"可行"的结论，但**不能跳过 §5 的 spike 直接排实现**；否则很可能在空值语义/导入上返工。

---

## 3. 候选路线

### 3.1 A. Project texts XLSX 往返（推荐）

**做法**：`project_texts(export)` → 解析 XLSX → 只把目标语言列的空单元格填上译文 →
`project_texts(import)` → 再导出一次做差异验证。

**优点**

- 官方设计用途就是翻译；覆盖 PLC 用户文本、HMI 用户文本、报警文本等"项目文本"大类
  （实际到哪一层以 §5 Q5 为准）；
- 一次文件、一次导入，**不用逐对象/逐块调用**；
- 不需要新增 Openness 操作，**C# 控制器可以完全不动**；
- 现有插件已经有导出/导入工具，剩下的是 XLSX 解析、合并、翻译编排与验证。

**缺点 / 限制**

- XLSX 布局没有正式文档，含系统列（`Internal ID`、`Substitutions`、`ref="n"`），
  只能改目标语言列；
- V17 API 导出**只给 source* + target 两列**（实测 22 列，其中 16 个是 `ref=` 列）；
  V14 样本里的 7 个语言列是 UI 的"多语言导出"，不代表 V17 API 的形状；
- 导入**不可回滚**、**只能同一项目**、**只能导回已存在的文本**；
- 空单元格的导入语义（跳过还是清空）、多语言列是否会被一并更新，都**待验证**；
- 工程大时导出/导入耗时未知。

### 3.2 B. 逐对象 `MultilingualText` API

**做法**：遍历块/标签/UDT，找到 `Comment`/`Title` 的 `MultilingualText`，写入中文 item。

**为什么不能当主方案**

- **没有创建 item 的 API**（激活语言是否生成空 item 待 Q3）；中文当前不存在，因此不能保证写进去；
- 覆盖对象不完全一致：不同对象是否暴露 `MultilingualText`、是否可写，要逐类确认；
- 逐对象写 = 上千次 Openness 调用，慢且容易在中间失败；事务只能保护单对象。

**还能用在哪**：目标语言 item 已存在时的**修正/重译**；或者 XLSX 覆盖不到的个别对象的补丁。
可作为 A 的补充，不作为主路线。

### 3.3 C. 块 XML 导出 → 改 `<MultiLanguageText>` → 导入

**做法**：`export_blocks` 得到 SimaticML，给 `<Comment>/<Title>` 增加
`<MultiLanguageText Lang="zh-CN">…</MultiLanguageText>`，再 `import_blocks`
（override）导回。

**优点**：精确到块；XML 结构公开（`SW.Common_v3.xsd` 的 `MultiLanguageText_T`）；
实测注释确实以 `MultiLanguageText` 形式存在（§2.3）。

**缺点**

- 导入是**整块替换**（不是补一条注释），会改变块的修改时间/指纹，且必须重新编译；
- 上千个块/对象（本次样本 1,376 个 XML）= 上千次导入；每次都要处理冲突、验证、失败重试；
- 覆盖不到标签表/HMI 等非块文本（或要另走一套）；
- 对"全项目翻译"来说，复杂度和风险都远高于 A。

**结论**：只作为 A 覆盖不到时的**定点补丁**，不作为主路线。

> 注意：XLSX 已经覆盖块标题/注释（§2.3），所以 C **不是**"唯一能翻块注释"的路线；
> 只有 XLSX 漏项、或需要整块替换/改结构时才用它。

### 3.4 D. UI 自动化 / 直接改工程文件

- UI 自动化：TIA Portal 的界面不是稳定的自动化接口，控件树/语言/版本一变就碎；
  仓库也明确不把"绕过厂商软件"当目标（`docs/vision.md` §6）。
- 直接改 `.ap17` 的内部文件：私有二进制格式，既不现实也不安全。

**❌ 排除。**

### 3.5 对比与结论

| 维度 | A. Project texts XLSX | B. 逐对象 API | C. 块 XML | D. UI / 私有格式 |
|---|---|---|---|---|
| 覆盖 PLC 块/网络/标签注释 | ✅ 官方"项目文本"大类 | ⚠️ 仅已有 item 的对象 | ⚠️ 仅块内 | ❌ |
| 能给"当前空白"的中文补文本 | ✅（待 Q2/Q3 验证） | ⚠️ 无创建 API（待 Q3） | ✅（逐块） | — |
| 写入粒度 / 事务 | 一次导入、**不可回滚** | 单对象事务 | 单块替换 | — |
| 规模适应性 | ✅ 一次文件 | ❌ 上千次调用 | ❌ 上千次导入 | — |
| 需要改 C# / Openness | ❌ 不需要 | 可能需要补 API | ❌ 不需要 | — |
| 主要风险 | 格式/空值/身份未验证 | 根本写不进去 | 整块替换、编译 | 不稳定 |
| **结论** | **推荐** | 仅辅助 | 仅补丁 | 排除 |

**推荐 A，B/C 作为补丁；先做 §5 的 spike。**

---

## 4. 推荐方案设计（A）

> 从用户 prompt 到导入验证、git 提交建议的完整状态机见
> [2026-11-03-project-text-translation-workflow.md](2026-11-03-project-text-translation-workflow.md)。
> 本文只讲方案与参数，不重复每一步的操作顺序。

### 4.1 总体流程

0. **准备（一次）** —— `project_languages(list)` 确认 reference/editing/active；
   target 未激活时**先征求用户许可**，再 `project_languages(set, active_languages=[target],
   active_mode="add")`；记录 before/after。`archive_project`（导入不可回滚，归档是唯一可靠的
   整工程回滚手段）。
1. **plan（只写文件，不改工程）** —— 按 `source_languages` 参数：
   **只给 1 个 = 单源，只导一份、不需要合并**；给多个才做多源合并（按 `Internal ID`
   取非空源）。不是默认多源。前提：API 接受非 reference 的 `source`；若只接受 reference，
   则临时切 reference、导出后恢复（**Q1 待验证**）。解析表头/语言列/`Internal ID`/`Category`/
   `ViewPath`/`ref=` 列；按范围、类别、路径前缀过滤；按 `text_id` 去重；输出 `jobs.jsonl`、
   `unique.jsonl` 与统计摘要（≤4KB）。
2. **translate（离线）** —— 50–100 条/批，带术语表与上下文（块名/网络名/类别）；
   产出 `translations.jsonl`；复用翻译记忆（TM）与已有目标语言文本。
3. **preflight（硬闸门，不通过就不导入）** —— 行数/`Internal ID` 未变；只改了目标语言列；
   无公式；占位符/换行保留；长度 ≤ 32,767；源列/其他语言列逐格哈希一致。
4. **apply（默认 false，需显式开启）** —— `project_texts(import,
   update_source_language=false)`；记录 `state`（Info/Warning/Error）与
   `resultPath`（导入日志）。
5. **verify（必须做）** —— 再导出一次，对比目标语言覆盖率和未成功的行；确认其他语言列/
   源列逐格不变；可选 `compile_plc`；**F 块已排除，不在 verify 范围**；出报告。
   `save_project` 是单独动作，不默认做。

`plan` 的默认值（**都只是默认，运行时参数可改，不是锁定选择**）：

- **只处理 `User Texts` sheet**；`System Texts` 默认不碰（它们是 TIA 生成的，不应翻译）；
- **`scope` 默认 `plc-comments`**（PLC 块/网络/标签/UDT 注释）；HMI/报警/系统文本用预设或自定义
  filter 显式开启；
- **源列为空的行默认跳过**并计入 `skipped_no_source`；不静默拿别的语言列顶替，
  除非显式给 `source_languages` 多个 / `fallback_sources`；
- **`target_policy` 默认 `only_empty`**（只补空）；可改为 `overwrite` 或 `fill_empty_keep_existing`。
  无论哪种策略，合并时**必须把不翻的行的原值原样写回单元格**（不能留空；否则若 Q2 证明
  "空白=清空"，会清掉已有译文）；
- **不排序、不插行、不改系统列**；只写目标语言列。

### 4.2 工具面：一个工作流工具，而不是五个原子工具

仓库的 `docs/tool-surface.md` §4.1/§4.2 已经把方向定清楚：**工作流层工具对模型默认可见，
内部自己编排原子操作；结果给摘要 + 工件路径 + 下钻方式**。本能力应按这个契约实现，
避免再增加一堆"每一步都要模型自己编排"的原子工具。

建议新增 **1 个**工具，放在 **`dsh-engineering-context` 的 `/tools` 行**（不是 TIA 插件）：
工作流、XLSX 处理、skill 都归工程上下文层；TIA 插件只保留 `project_texts` / `project_languages`
原子工具，并新增窄服务 `projectTextAccess`（export/import/languages/archive/save）给 context 调用。

```ts
project_translate({
  action: 'plan' | 'apply' | 'status' | 'template',
  source_languages?: string[],        // 1 个 = 单源（不合并）；多个 = 可选多源合并；默认 [reference]
  target_language: string,            // 任意 TIA 支持的语言；未激活时先征求许可
  target_activation?: 'ask' | 'never',// 默认 ask：plan 报 needs_permission，不自动改
  scope?: 'plc-comments' | 'plc-all' | 'hmi-user-texts' | 'all-user-texts' | FilterObject,
  categories?: string[],              // 从导出文件 Category 列枚举
  path_prefix?: string,               // 例如 "Sino_PEI/"
  target_policy?: 'only_empty' | 'overwrite' | 'fill_empty_keep_existing',
  merge_strategy?: 'priority' | 'first_non_empty' | 'detect_language',
  only_empty?: boolean,               // 兼容快捷参数，等价 target_policy=only_empty
  apply?: boolean,                    // 默认 false；true 才导入
  translations_file?: string,         // apply 时必填
  max_rows?: number,                  // 试点用
  backup?: 'archive' | 'none',        // 默认 archive
})
```

> `source_languages` 只有 1 个时就是普通单源导出；**多源合并是可选项，不是默认流程**。
> `target_language` 只决定 `project_texts` 的 target 参数；任何 TIA 支持的语言都可以，
> 但必须先处于 active（或由工具按开关激活）。`scope` 既可以选预设，也可以传自定义 filter。

- `plan`：导出 + 解析 + 过滤 + 去重 + 统计 + 落工件；不写工程（语言激活除外，且单独开关）。
- `template`：额外生成一份"人可编辑"的 CSV（source/target/context），供人工或外部翻译。
- `apply`：preflight → 合并 → 导入 → 再导出验证 → 报告；`apply:false` 时只报告"将会做什么"。
- `status`：只导出并统计当前目标语言覆盖率，不写工程。

结果契约按 `docs/tool-surface.md` R1–R8：

- 文本结果 ≤ ~4KB / 40 行；
- 完整数据落盘：`jobs.jsonl`、`unique.jsonl`、`translated.xlsx`、`report.json`、`import.log`；
- 失败优先：导入 Warning/Error、未覆盖行、占位符不匹配等**全量列出**（或落盘 + 计数）；
- 长操作给阶段摘要/句柄（导出/导入可能几十秒到几分钟）。

> 工具数量上的取舍：也可以把它拆成 `project_text_plan` / `project_text_apply` 两个工具，
> 但按仓库"工作流层"的方向，一个带 `action` 的工具更省常驻 token，也更难被模型用错。

### 4.3 数据契约（建议）

`jobs.jsonl`（一行一个待译行；`text_id` 相同的行共享同一译文）：

```jsonc
{"row": 2, "text_id": "sha256:…", "category": "<PlcBlock>", "view_path": "Sino_PEI/…",
 "source": "Start motor", "existing_target": "", "context": {"block": "FB_Motor", "network": "Network 3"}}
```

`unique.jsonl`（去重后的翻译单元）：

```jsonc
{"text_id": "sha256:…", "source": "Start motor", "count": 3, "categories": ["<PlcBlock>"],
 "contexts": ["FB_Motor / Network 3", "FB_Motor / Network 7"]}
```

`translations.jsonl`（模型/人/MT 的产出）：

```jsonc
{"text_id": "sha256:…", "target": "启动电机", "confidence": "high", "note": ""}
```

`report.json`（最终交付）：

```jsonc
{"rows": 3210, "planned": 2870, "translated": 2868, "skipped_existing": 340,
 "import": {"state": "Info", "logPath": "…"},
 "verify": {"targetCoverageBefore": 0.0, "targetCoverageAfter": 0.997,
            "missing": 2, "otherCellsChanged": 0},
 "artifacts": {"source": "…/texts.xlsx", "translated": "…/translated.xlsx",
               "jobs": "…/jobs.jsonl", "translations": "…/translations.jsonl"},
 "elapsedMs": {"export": 0, "import": 0}}
```

> `text_id` 默认按"源文本 + 类别"生成；同一英文词在不同上下文可能需要不同译法。
> 允许按 `view_path` 拆分，并允许 `translations.jsonl` 对同一 `text_id` 给出覆盖值。

### 4.4 XLSX 的列与行身份（实现的关键）

根据 2026-11-02 的 V17 真机导出（§2.3），实际布局是：

| 列 | 含义 | 是否可改 |
|---|---|---|
| A `Category` | 文本类别，如 `<BlockCommentCategoryData>` / `<TagCommentCategoryData>` | ❌ 系统列 |
| B `ViewPath` | 对象路径；末尾是 `Title` / `Comment` / `Text` 等文本类型 | ❌ |
| C `Internal ID` | 文本身份；本次 33,045 行**全部唯一** | ❌ |
| D `Substitutions` | 占位符替换值（本次 1,499 行非空） | ❌ |
| E `en-GB*` | 源/参考语言列，表头带 `*` | 只读 |
| F `zh-CN` | 目标语言列 | **只改这一列** |
| G–V `ref="0"`…`ref="15"` | 占位符/引用列（16 列） | ❌ |

实现约束：

- 用户说的"段落注释"对应 `...\Network N\Comment`；"备注"对应 `...\Comment`
  （块注释/标签注释）。本次实测块注释类 **7,501 行待补**、标签注释 **446 行待补**（§2.3）；
- **按表头找列**，不要按固定列号；表头可能带 `*` 或空格，要归一化；
- **人工不要直接用 Excel 改 `Internal ID` 列**：Excel 可能把长 ID 识别成数字/科学计数法；
  优先用工具合并，或在 Excel 里把该列预设为文本；
- **保留行顺序、列顺序、所有系统列原值**；只写目标语言列的单元格；
- **不要重排/排序/插行**；导入靠 `Internal ID` 匹配；
- 目标列如果同时存在 `zh-CN` 和 `zh-CN*`（参考语言恰好是中文），要明确选哪个；
- 表格里可能有 `"=..."` 开头的注释：**不能让它变成公式**（写字符串，不写公式）；
- 文本里的换行、`@1%` 之类占位符、`%s`、`{}` 要保留；
- 单格 ≤ 32,767 字符（TIA 帮助明确）。

> ⚠️ V14 样本的 7 个语言列是 UI 的"多语言导出"；V17 API 实测只给 source* + target + 16 个
> `ref=` 列。两个公开工具可交叉参考：Python 按表头 culture 名找列；Go 把前 4 列当元数据、
> 跳过 `ref=` 列、用 `quick` 模式只填空的目标单元格。

### 4.5 翻译编排：DSH 原生优先

DSH 插件运行时目前没有向插件暴露"调用模型"的服务——至少本包可用的运行时声明里没有
（`src/dsh-runtime.d.ts` 只声明了 `skills`/`commands`/`tools` 等；是否另有全局 LLM 服务，
需要单独确认）。因此 v1 的现实做法是：

**工具做确定性的事（解析/合并/校验/导入/验证），模型做翻译。**

- 新增一个 skill（放在 TIA 插件的 `skills/` 下，随技能提供器发布），定义：
  - 批次大小（50–100 条/批）、术语表、上下文列怎么用；
  - 占位符/标识符"不翻译"规则；
  - 产出 `translations.jsonl` 的严格 schema；
  - apply 前必须人工/模型复核（尤其安全注释）；
  - 大项目用 `workflow` 把批次分给子 agent（每个子 agent 只回结构化 JSON）。
- 翻译记忆（TM）：`text_id → target` 的 JSONL/SQLite 缓存，跨批次/跨会话复用；
  相同源文本不重复翻。
- **源列语言混杂 / 多源导出**：本次实测 `en-GB*` 列里大量是法语（作者用英/法混写），
  而且有的块标题/注释只在 `en-US`/`fr-FR`/`de-DE` 里有文本（§2.3 的 `LCCF_CipClient` 例子）。
  翻译前先做语言识别；**按多种源语言各导一份，按 `Internal ID` 合并，取非空源**。
  前提是 API 接受非 reference 的 `source`；若只接受 reference，则临时切 reference、
  导出后恢复（Q1 待验证）。**不要假设列名是 `en-GB` 就等于英文，也不要只导一份就断言
  "这些块没有注释"。**
- 术语表：CSV/JSON（源词 → 目标词），作为提示词约束 + 后置校验（术语未命中则标 `low`）。

**v2 可选：外部 MT provider 适配器。** 在插件配置里给 `base_url` / `model` / `api_key_env`，
由工具直接批量调用（OpenAI 兼容/DeepL/Azure），支持并发、重试、缓存。好处是 6 千行不必
经过模型上下文、成本可预测；代价是新增凭据与数据外发面，需要单独决策。

### 4.6 安全与回滚

| 措施 | 说明 |
|---|---|
| **归档** | `apply` 前 `archive_project`（或要求用户先归档）；这是整工程回滚的唯一可靠手段 |
| **只写副本** | 永远不修改原始导出文件；生成 `translated.xlsx`，原文件保留 |
| **preflight 硬闸门** | 行数/ID 不变；只改目标列；源列/其他语言列逐格哈希一致；否则拒绝导入 |
| **不自动保存** | 导入后工程处于已修改状态；`save_project` 单独动作，报告里明确提示 |
| **导入日志** | 把 `ProjectTextResult.Path` 指向的文件原样保留并给出路径 |
| **失败即停** | `state=Error` / 大量 Warning 时不重试、不继续；先看日志与再导出差异 |
| **审批门** | 若宿主支持 approval，`apply` 走审批；不支持时至少要求显式 `apply:true` + 报告 + 归档路径 |
| **F 块** | **已决定不翻译**；只按 `programmingLanguage=F_*` 识别并排除（**不用组名**），不做 `safety_signatures` 验证 |
| **并发** | 控制器串行；翻译离线进行，不要与别的 TIA 写操作交叉 |
| **数据外发** | 注释可能含客户工艺信息；用外部 LLM/MT 前必须让用户明确同意，或走本地模型/私有端点 |

### 4.7 与现有插件的关系

- **TIA 插件（接口层）**：不新增 `exceljs`；保留 `project_texts` / `project_languages` 原子工具，
  并新增窄服务 **`projectTextAccess`**：
  `exportTexts` / `importTexts` / `readLanguages` / `setLanguages` / `archiveProject` / `saveProject`。
  不把 `importTexts`/`setLanguages` 塞进只读定位的 `engineeringAccess`。
- **工程上下文插件（工作流层）**：`project_translate` + 翻译 skill + `exceljs` 都在这里；
  XLSX 解析/写回、preflight、报告、git 提交建议也在这里（已有 `commit.ts`/`git.ts`）。
- **数据流**：context → `projectTextAccess.exportTexts` → XLSX → context 用 `exceljs` 解析/合并
  → `projectTextAccess.importTexts`；TIA 插件不接触单元格。
- **不改 C# 控制器 / 不新增 Openness 操作**：`project_texts` 与 `project_languages` 已经够用；
  若 XLSX 保真度不够，换的是 context 侧的库（OpenXML 也在 context/controller 二选一），不是 Openness 操作。
- **工件目录**：`<workspace>/translations/<project>/<timestamp>/`，需要加 `.gitignore`。
- **依赖方向**：只允许 context → TIA 服务；禁止 TIA 插件 import context 的 `exceljs` 或共享包。

---

## 5. 必须先做的 spike（P0，1–2 天）

目标：在**项目副本**上，用最小的手工步骤回答下面 8 个问题；任何一个"不过"，方案就要改。

> 环境：TIA V17 + 一个可写的项目副本（优先 `create_engineering_project` 生成的副本；
> 不要拿正式工程做导入实验）。每次导入前先 `archive_project`。
> spike 期间避免与另一个 DSH 会话的 TIA 写操作并发：控制器是串行的，长操作会排队，
> 也容易把"谁改了工程"搞混。
>
> 大工程打开：根 README 的插件表记录过"可见窗口打开工程 68–197 s（headless 会挂）"。
> spike 先用 `with_window: true` 打开副本；headless 的可行性单独作为 Q6 的附加项测。

最小命令序列（参数名以当前工具 schema 为准）：

```jsonc
open_project({ "project_path": "D:\\Verify\\Copy\\Copy.ap17" })
project_languages({ "action": "list" })
project_languages({ "action": "set", "active_languages": ["zh-CN"], "active_mode": "add" })
project_texts({ "action": "export", "file": "D:\\Verify\\texts-v17.xlsx",
                "source_language": "en-GB", "target_language": "zh-CN" })
// 用 Excel 只改一个目标语言单元格，另存为 texts-v17-one-cell.xlsx（不要改其他列）
project_texts({ "action": "import", "file": "D:\\Verify\\texts-v17-one-cell.xlsx",
                "update_source_language": false })
```

### Q1. V17 导出的 XLSX 到底是什么布局？—— ✅ 已实测（2026-11-02）

- **结果**：`User Texts` **33,045 行 × 22 列**；列 = `Category, ViewPath, Internal ID,
  Substitutions, en-GB*, zh-CN, ref="0"…ref="15"`；`Internal ID` **全部唯一**；
  源列混有法语；目标列已有 6,485 行中文。详见 §2.3 / §4.4。
- **仍需补做**：
  - 零改动 round-trip：用计划采用的库（如 `exceljs`）打开后**原样另存**，再导入；
    若这一步失败，是库的保真度问题，不是翻译逻辑；
  - `source_language=fr-FR` 是否也能导出（本次实测只用了 `en-GB`）；
  - V15/V16 等其他 TIA 版本的列布局是否相同。
- **不过怎么办**：以目标版本实际表头为准重写列映射。

### Q2. 空目标单元格导入时是"跳过"还是"清空"？

- **做法**：本项目 `zh-CN` 已有 6,485 行译文（§2.3），足够做观察。导出
  `source=en-GB, target=zh-CN`；找一行**已有中文**的记录，把它的 `zh-CN` 单元格清空
  （其余不动），导入；再导出，看这条记录的中文是否被清空。
- **通过标准**：清空一个已有译文单元格后导入，原译文**保持不变**（说明空白=跳过），
  或明确变成空白（说明空白=清空，合并时必须为每一行填值）。
- **不过怎么办**：若空白会清空，合并时必须为每一行写入"已有译文或新译文"，不能留空。

### Q3. 导入能否给"原本没有目标语言项"的文本新建 item？

- **做法**：选 3 条当前中文为空白的块/网络注释，填中文，导入，切 editing language 到中文，
  在 TIA 里打开块确认。
- **通过标准**：能看到中文，且源语言/其他语言不变。
- **不过怎么办**：A 路线不成立；只能走 B（已有项）+ C（块 XML）组合，工期和风险都会显著上升。

### Q4. 行身份在"重新打开/保存"后是否稳定？

- **本次观察**：33,045 行的 `Internal ID` **全部唯一**（无重复），是导入匹配的好基础；
  但"重开工程 / SaveAs 后再导入"尚未测。
- **做法**：导出 → 关闭工程 → 重新打开（不要 SaveAs）→ 用同一文件导入；再试一次
  "导出后 SaveAs，再导入"（预期失败）。
- **通过标准**：同一项目重开后导入仍按 `Internal ID` 命中；SaveAs 后失败的行为与手册一致。
- **不过怎么办**：工作流必须强制"导出→导入同一会话"，并在 close/save-as 后重新导出。

### Q5. 覆盖范围到底包含哪些文本？—— ✅ 类别已实测（2026-11-02）

- **结果**：`User Texts` 共 12 类；块注释类 10,175 行（**7,501 待补**）、标签注释 453 行
  （**446 待补**）、硬件模块注释 83 行（**81 待补**）、HMI runtime 675 行（100 待补）、
  HMI screen 3,722 行（仅 8 待补）、文本列表 749 行（5 待补）、报警 16,962 行（3 待补）。
  详见 §2.3。
- **仍需做**：抽查 3 类在导入后 TIA 里确实变了；`System Texts`（1,063 行）是否应排除。
- **不过怎么办**：对缺失类别用 C（块 XML）补；HMI 另走文本列表通道。

### Q6. 导出/导入的耗时与文件大小？

- **本次实测**：TIA 启动 + 打开工程约 1 分钟；导出写盘约 3 分钟
  （33,045 行，4,108,066 字节）。
- **坑**：`with_window:true` 时 TIA 在导出完成后弹出 **"Export Completed" 模态框**，
  `ExportProjectTexts` 的 API 调用一直不返回（本次 15 分钟超时）；点掉对话框后控制器才退出。
  详见 R16。
- **仍需测**：导入耗时/日志；headless（`with_window:false`）是否没有模态框；
  更大工程的分片策略。

### Q7. 失败形态是否可解释？

- **做法**：导出后删除/重命名一个块，再导入；观察 `state`、`resultPath` 内容、
  工程是否部分被改；用再导出确认哪些行成功。
- **通过标准**：能从日志/再导出差异定位失败行；不会静默写坏。
- **不过怎么办**：导入前强制归档 + 导入后强制再导出对比；把"部分失败"当一等公民设计。

### Q8. F 块/受保护块？—— 已决定排除

- **决定**：v1 **不翻译 F 块（安全程序）**，也不测试注释对安全签名的影响；F 块整块不动。
- **仍需验证**：只从 `list_plc_objects` 的 `programmingLanguage`（`F_LAD`/`F_FBD`/`F_DB`…）
  拿 F 块清单；**不依赖组名**（组名是随机的，没有分类语义）。在 filter 中排除；
  受保护块按导入报错/跳过处理。
- **通过标准**：`jobs.jsonl` / `selected.jsonl` 中 F 块 **0 条**；普通块不受影响。

**P0 产出**：一份 `docs/reviews/…-spike.md`，逐项记录命令、原始输出、结论；
以及一个"go / no-go / 改路线"的决定。

---

## 6. 风险清单与对策

| # | 风险 | 触发条件 | 影响 | 对策 | 验证 |
|---|---|---|---|---|---|
| R1 | 导入不可回滚 | 任何 `project_texts(import)` | 工程文本被部分/错误修改 | 导入前归档；只改目标列；失败即停；保存原始 XLSX | Q2/Q7 |
| R2 | 空值语义未知 | 目标单元格为空 | 可能清空已有译文 | 先测 Q2；默认"只填空"；必要时填满所有行 | Q2 |
| R3 | 行身份/同项目绑定 | 导出后重开、SaveAs、删块 | 导入失败或错位 | 同一会话内完成；不 SaveAs；不改工程；失败后重新导出 | Q4/Q7 |
| R4 | V17 列布局与样本不同 | 版本差异 | 写错列/导入被拒 | 按表头解析；Q1 验证；preflight 校验非目标列不变 | Q1 |
| R5 | `project_texts` 未真机验证 | 首次使用 | 通道本身不可用 | 先做 P0；不要在未验证前排实现 | Q1–Q8 |
| R6 | 导入日志语义不明 | `state=Warning/Error` | 无法定位失败行 | 保留 `resultPath`；再导出对比；把日志纳入报告 | Q7 |
| R7 | 译文质量/术语不一致 | 大批量机翻 | 可读性差、歧义 | 术语表 + 上下文 + 去重 + 抽样复核 + `confidence` | 试点 |
| R8 | 标识符/占位符被误翻 | 注释含 `@1%`、`%s`、`{}`、块名 | 文本语义/报警占位错 | 不翻译规则 + preflight 占位符校验 | 单测 |
| R9 | 以 `=` 开头的文本变公式 | Excel 写入方式不当 | 文本丢失/导入异常 | 强制按字符串写；preflight 检查单元格类型 | 单测 |
| R10 | 长文本超限 | > 32,767 字符 | 导入失败 | preflight 检查、跳过并标记，交人工处理 | 单测 |
| R11 | 中文显示不出来 | 缺 Windows 东亚语言包 | 数据有但显示方块 | 文档提示；不当作数据错误 | 文档 |
| R12 | 误把 F 块纳入 | 过滤规则漏识别 F 块 | 安全程序被改文本/需重新验收 | 已决定不翻译；只按 `programmingLanguage=F_*` 排除（不用组名）；断言 0 条 | T18 |
| R13 | 数据外发 | 注释含客户工艺信息 | 合规/保密风险 | 明确同意；本地模型/私有端点；脱敏选项 | 决策 |
| R14 | 大工程超时/挂起 | 导出/导入慢；headless 打开大工程会挂 | 会话中断 | 分片、进度、可续跑；大工程先用可见窗口；调大 `requestTimeoutMs` | Q6 |
| R15 | 并发会话 | 另一个会话在写同一项目 | 冲突/排队 | 控制器串行；翻译离线；写前确认无其他写操作 | 运行约定 |
| R16 | 导出完成模态框阻塞调用 | `with_window:true`，`ExportProjectTexts` 完成后弹 "Export Completed" | API 不返回（实测 15 min 超时），工作流卡死 | 优先 headless；UI 模式自动点掉对话框；调用侧以"文件已生成"为旁路继续 | **已实测** |

---

## 7. 工作量与里程碑（1 人估算）

| 阶段 | 内容 | 估算 | 交付物 |
|---|---|---:|---|
| **P0 spike** | §5 的 Q1–Q8；项目副本 | **1–2 天（首次环境可能 2–3 天）** | spike 记录 + go/no-go |
| **P1 计划/解析** | `project_translate(plan/status)`；XLSX 解析、列映射、过滤、去重、统计、工件 | 4–6 天 | 工具 + 单测 |
| **P2 合并/导入/验证** | preflight、写回、导入、再导出 diff、报告、归档/失败处理 | 4–6 天 | 工具 + 真机记录 |
| **P3 翻译编排** | skill、批次、术语表、TM、占位符/QA、`workflow` 分片 | 4–6 天 | skill + 试点报告 |
| **P4 加固/试点** | 真实项目试点、异常注入、文档、性能 | 3–5 天 | 验收报告 |
| **合计** | | **16–25 人天（约 3–5 周）** | |

- **最小演示闭环**（P0 + P1 的解析 + 100 行手工翻译 + P2 的导入/验证）约 **7–9 天**。
- 如果 `exceljs` 保真度不够、要改用 C# `DocumentFormat.OpenXml`：**+3–5 天**。
- 如果 v2 要加外部 MT provider：**+5–7 天**（含配置、凭据、重试、成本控制）。
- 不含人工翻译审校、术语表建设、HMI 全量覆盖。

---

## 8. 验收标准（建议）

**P0（通道）**

- [ ] Q1–Q8 全部有书面结论；至少 Q2/Q3/Q4 是"通过"；
- [ ] 在一个 100 行试点上：导出 → 填 100 行 → 导入 → 再导出，目标列 100% 有值；
- [ ] 其他语言列、源列、`Internal ID`、系统列逐格不变（哈希/逐格 diff）；
- [ ] 导入 `state=Info`（或 Warning 可解释）；日志路径已记录；
- [ ] 工程可编译，`errors=0`；F 块 **0 条**进入 `selected.jsonl`（已决定不翻译）。

**v1（全项目）**

- [ ] 目标语言覆盖率 ≥ 99.5%（可翻译且源非空的行）；
- [ ] 未覆盖/失败行有逐行原因（落盘 + 摘要）；
- [ ] 6,000 行量级的 plan + apply 在可接受时间内完成（不含 LLM 时间，目标 < 5 分钟）；
- [ ] 报告包含：before/after 覆盖率、导入 state、日志路径、其他列未变证明；
- [ ] 文档写清：如何归档、如何切 editing language 检查、失败如何回滚。

---

## 9. 运行时参数与仍需确认的产品决策

> 语言、范围、覆盖策略都**不需要在方案阶段定死**；它们是 `project_translate` 的参数。
> 下面只是默认值，以及少数需要拍板的产品约束。

**运行时参数（用户每次选，不锁死）**

- `source_languages`：默认 `[reference]`；给 1 个就是单源、不合并；给多个才做可选合并。
- `target_language`：任意 TIA 支持的语言；未激活时**先征求用户许可**（`target_activation=ask`，
  plan 报 `needs_permission`，不静默改项目）。
- `scope`：`plc-comments` / `plc-all` / `hmi-user-texts` / `all-user-texts` / 自定义 filter
  （类别、路径、块名、网络号、文本类型、include/exclude）。
- `target_policy`：`only_empty`（默认）/ `overwrite` / `fill_empty_keep_existing`。
- `merge_strategy`：`priority` / `first_non_empty` / `detect_language`（仅多源时生效）。
- `translation_instruction`：目标语言、术语表、上下文规则；由 skill 生成，模型执行翻译。

**已确认的产品决策**

1. **F 块识别**：只按 `programmingLanguage=F_*`，**不用组名**（组名是用户任意命名、无分类语义）；
   待测 T18 确认能覆盖全部 F 块且不误伤普通块。
2. **目标语言激活**：允许自动 `active_languages.add(target)`，但**必须先征求用户许可**；
   记录 before/after，不静默改项目（`target_activation=ask`）。
3. **数据合规**：接受注释进入当前模型；v1 只走模型翻译，不强制外部 MT/私有端点
   （将来可作为可选适配器，不进入默认路径）。
4. **交付形态**：`project_translate` + 翻译 skill 放 `dsh-engineering-context`；TIA 插件保留
   原子工具并新增 `projectTextAccess` 服务；`exceljs` 依赖在 context。已确认。
5. **默认值**：`source_languages=[reference]`、`scope=plc-comments`、`target_policy=only_empty`；
   都只是默认，运行时参数可改。

**仍需实测（不影响已确认的架构）**

- T1：`source` 是否必须是 reference；
- T5：目标单元格空白 = 跳过还是清空；
- T6：导入能否给原本没有目标语言 item 的文本新建；
- T18：`programmingLanguage=F_*` 是否覆盖全部 F 块（只用语言，不用组名）。

---

## 10. 证据与来源

### 10.1 官方手册 / 帮助（本机 TIA V17）

- Openness V17 帮助包：`C:\Program Files\Siemens\Automation\Portal V17\Help\en-US\TIAPortalOpennessenUS.zip`
  - "Export of project texts"（导出参数、四条限制、多语言随父对象）
  - "Import of project texts"（`updateSourceLanguage`、只能导回同项目、只能已存在文本）
  - "Accessing and enumerating multilingual texts"（`Language` 只读、`Text` 读写、`Find`）
  - "Accessing languages"（`ActiveLanguages.Add/Remove`、`EditingLanguage`、`ReferenceLanguage`）
  - "Exporting GRAPH blocks with multi-language text"（未显式设置的语言不导出）
- TIA 帮助包：`…\Help\en-US\PEProjectDataenUS.zip`
  - "Project text basics"（project/editing/reference language；块/网络/表格/报警文本）
  - "Exporting project texts" / "Importing project texts"（XLSX、源/目标语言列、Import source language）
  - "Translating project texts using reference texts"（新语言无译文时输入框为空）
  - "Editing multilingual project texts in blocks"（块标题/网络/接口/操作数注释；32,767 字符上限）
- Openness API 文档：`C:\Program Files\Siemens\Automation\Portal V17\PublicAPI\V17\Siemens.Engineering.xml`
  - `ProjectBase.ExportProjectTexts` / `ImportProjectTexts`
  - `MultilingualText` / `MultilingualTextItem` / `LanguageSettings`

### 10.2 仓库代码与文档

- `packages/dsh-tia-openness-v17-min/src/tools.ts:1520` —— `project_texts`；导入不包事务、无 dry-run。
- `packages/dsh-tia-openness-v17-min/controller/OpennessHost.Project.cs:698,735,738,811,844` ——
  "不能创建缺失语言项"、导出/导入实现。
- `packages/dsh-tia-openness-v17-min/docs/VERIFICATION-PLAN.md:130-151` —— §2.5 高风险；
  2.15–2.17 未勾选；`ProjectTextResult.Path` 语义未知；事务限制。
- `packages/dsh-tia-openness-v17-min/docs/decisions.md:561-562` —— `project_texts` 导入不可回滚，
  正确补偿是用户审批而非 dry-run。
- `docs/tool-surface.md` §4.1/§4.2/§4.3 —— 工作流层工具、工件 + 下钻、结果预算。
- `packages/dsh-tia-openness-v17-min/docs/EXTENDED-SURFACE.md:11` —— ProjectTexts 属于
  "Functions for projects and project data" 扩展面。

### 10.3 第三方参考（仅用于交叉验证格式，不是权威依据）

- `kurcontko/tia-portal-translator`（MIT，Python/openpyxl）：按表头 culture 名找源/目标列，
  默认 sheet "User Texts"，`quick` 模式只填空目标。  
  <https://github.com/kurcontko/tia-portal-translator>
- `rlhf23/tiaprojecttext_translator_go`（MIT，Go/excelize）：TIA 文件前 4 列视为元数据，
  跳过 `ref=` 列；`quick` 模式跳过已有目标文本；占位符/短文本/数字直接复制。  
  <https://github.com/rlhf23/tiaprojecttext_translator_go>
- 上述 Python 仓库内的 `TIAProjectTexts.xlsx` 样本（TIA V14 时代）：sheet
  `User Texts`/`System Texts`；列 `Category, ViewPath, Internal ID, Substitutions`；
  语言列（参考语言带 `*`）；`ref="0".."15"` 列。**V17 未验证，仅作格式预期。**

### 10.4 本文实测数据

- **XML 导出物**：`C:\Users\Ansel\Documents\dsh-automation-suite\SWT2_PEI_1026_Night\source\Sino_PEI`
  （2026-10-26 由 `create_engineering_project` 导出的项目副本源树；1,376 个 XML）。
  统计方法：递归读取 XML，正则 `<MultiLanguageText Lang="([^"]+)">`；见 §2.3 表。
  局限：XML 只含显式设置的语言；文本项数 ≠ XLSX 行数；项目副本可能与当前源项目不同。
- **V17 XLSX**（2026-11-02）：`temp/tia-texts/ProjectTexts-2026-11-02T14-28-14-407Z.xlsx`
  （4,108,066 字节；`User Texts` 33,045 行 × 22 列；`System Texts` 1,063 行）。
  运行方式：控制器 `OpenProject(with_window=true)` → `ProjectLanguages(list)` →
  `ProjectTexts(export, source=en-GB, target=zh-CN)`。
  工程副本：`...\SWT2_PEI_1026_Night\tia\SWT2_PEI_1026_Night\SWT2_PEI_1026_Night.ap17`。
  活动语言 7 个：`fr-FR, de-DE, en-GB, es-MX, th-TH, zh-CN, en-US`；editing/reference 均为 `en-GB`。
  导出约 3 分钟写盘完成；但 `with_window:true` 下 TIA 弹出 "Export Completed" 模态框，
  API 调用直到点掉对话框才返回（本次 15 分钟超时后才人工点掉）。

### 10.5 尚未验证（不要当成结论）

- 空目标单元格的导入语义（跳过/清空）；
- 导入能否为缺失语言项新建文本（本方案成立的前提）；
- `source_language=fr-FR` 等其他活动语言能否作为导出源；
- `ProjectTextResult.Path` 指向的文件内容、导入 `state=Warning` 的逐行含义；
- headless（`with_window:false`）能否避开 "Export Completed" 模态框；
- `exceljs` 对 TIA 生成 XLSX 的保真度（零改动 round-trip）；
- 导入耗时、部分失败与回滚路径。

以上全部列入 §5，P0 之前不应视为已解决。
