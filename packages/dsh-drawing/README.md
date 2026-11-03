# @voltarenyah/dsh-drawing

DSH 插件：**电气图纸**。把一份 PDF 图纸集吃进工作区，建成可检索的索引，让 agent 回答"这根线在哪张图、这个位号连着哪几页、这张图写了什么"，并把定位结果推到右侧栏 **Drawing** 页给用户看。

设计依据与实测数据见 `docs/research/drawing-plugin-plan.md` 与 `docs/research/electrical-drawings-see-swt2-pei.md`。

## 它做什么

| 工具 | 作用 |
|---|---|
| `drawing_status` | 只读探测：工作区里有哪些图纸、是否已建索引（毫秒级，不读 PDF） |
| `drawing_open` | 入库 + 建档：把 PDF **复制**进 `drawing/`，按 sha256 解析一次并落盘；重复调用命中缓存 |
| `drawing_search` | 在位号 / 线号 / 电缆 / PLC 地址 / 端子排 / 交叉引用 / 标题里检索，返回页 + 命中框 |
| `drawing_sheet` | 单页结构化内容：标题块、该页元素、已解析的出向交叉引用 |
| `drawing_show` | 让右侧栏翻到指定页并高亮（只回一行确认，不发图片） |

解析**是代码，不是模型**：一份 353 页的 SEE 图纸集解析约 2.4 秒、0 token；模型只消费检索结果（每次几十到几百 token）。

## 目录布局

```
<workspace>/drawing/
├── PEI---SWT2_20260527.pdf          ← 入库时复制的副本（原件不动）
└── PEI---SWT2_20260527/             ← 派生物，与 PDF 同名
    ├── profile.json                 ← 档案卡：工程身份、电柜、模板统计、注意事项
    ├── build.json                   ← sha256 / 解析器版本 / 耗时 / 自检
    └── index/
        ├── sheets.json              ← 每页：电柜、图号、标题、模板、上一张/下一张
        ├── xrefs.json               ← 交叉引用（含解析到的目标页）
        └── names.json               ← 位号/线号/电缆/地址/端子 → 出现位置与框
```

另外在 `<workspace>/.dsh/drawing-manifest.json` 写一份给浏览器半侧读的清单（固定位置，与 `dir` 配置无关）。

## 配置

```yaml
- id: drawing
  name: '@voltarenyah/dsh-drawing'
  config:
    dir: drawing     # 工作区内放图纸与索引的目录，默认 drawing
```

## 当前范围

- **已实现（P0 + P1）**：五个工具、PDF 入库与解析、页/交叉引用/实体三类索引、档案卡、右侧栏 Drawing tab（图纸列表 + 档案摘要 + 可筛选图号列表）。
- **未实现（后续）**：电缆/端子/通道表格（P2）、页面渲染与高亮联动（P3/P4）、SEE `Project Data extraction` XML 通道（P2.5）。

## 技术要点

- PDF 引擎是 [`unpdf`](https://www.npmjs.com/package/unpdf)（MIT，3.1 MB，内含 pdf.js）。它给每个文本 run 的 `transform` + `width`，坐标与 PDFium 逐位一致；`@hyzyla/pdfium` 没有文本几何，`mupdf` 是 AGPL 不能随插件分发。
- 打印件把每张图旋转 90°（只有 24 页针脚图是 180°），所以 `src/indexer/rules.ts` 的 `placeItem()` 负责把文本矩阵合成到显示坐标系——这是全部几何能力的入口。
- 索引按 `sha256 + PARSER_VERSION` 缓存，从不由查询触发重新解析。

## 开发

```powershell
node scripts/link-dsh-runtime.mjs   # 首次：把 dsh-tools/cordis/schemastery 链进来
node scripts/build.mjs              # tsc 宿主 + esbuild 浏览器半侧
node scripts/run-tests.mjs          # 纯规则 + 工具契约 + 真实图纸基线（缺 PDF 时跳过）
node scripts/smoke.mjs [pdfPath]    # 端到端：入库 → 检索 → 单页 → 定位
```

基线测试用 `DRAWING_TEST_PDF` 指向一份 353 页的 SEE 图纸集；不在本机时该用例 **skip**，不会失败。
