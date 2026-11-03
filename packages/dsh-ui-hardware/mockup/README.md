# Hardware 页面 · HTML 样板

用于验收 `dsh-ui-hardware` 右侧栏 tab 的**外观与时序**，不是插件本体。验收通过后再按
`dsh-ui-versions` 的模式做成插件（host half + client half + esbuild bundle）。

打开 `hardware.html`（单文件、无外部依赖）。

## 数据来源：全部来自现有工具

| 区块 | 来源 | 是否需要 TIA |
|---|---|---|
| 设备、机架、槽位、订货号、固件、通道数 | `hardware_inventory`（读 AML） | 否 |
| 地址、子网/节点/IO 系统、连线、信号映射 | `hardware_configuration`（读 AML） | 否 |
| **F 参数**（仅在 `COF-BASE-A` / `COF-BASE-A_1` / `ET 200SP_1` 三台设备上） | `hardware_parameters`（对象模型） | **是** |

`inventory.json` / `configuration.json` 是控制器对
`SWT2_PEI_1026_Night/hardware/globalHardware.aml` 的真实输出（17 设备 / 144 模块 / 472 通道 /
356 条信号 / 48 条连线）。F 参数是 2026-11-02 用 `hardware_parameters` 实测的值，**硬编码在
`gen.mjs` 的 `F_MEASURED`** 里——因为那份数据必须开工程才拿得到，而样板页不联网也不连 TIA。

两处演示性内容，看的时候请当占位：

- `HMI_1` 那一行是**合成**的：它在工程里存在、被 CAx 跳过，所以侧表里用琥珀点标成
  “未导出”，原因字符串取自导出日志的 `logProblems`。
- 语言/主题切换是 demo 开关。真实插件跟随 DSH 全局语言设置与宿主 `--dsw-*` token，不自己藏一份配色。

## 重新生成

```powershell
cd packages/dsh-ui-hardware/mockup
node gen.mjs          # inventory.json + configuration.json + page.tpl.html -> hardware.html
```

改数据：把 `inventory.json` / `configuration.json` 换成别的工程的输出即可，`gen.mjs` 只做合并
（设备身份取 head module 的型号/订货号/固件、IP 与 PROFINET 名取 `network.nodes`、子网归属取
`node-subnet` 连线、信号按 channel 所属设备分组）。

## 版式：按"工程机架"重做（2026-11-03）

上一版是"卡片墙"——身份、槽位表、网络、信号各一张等权重卡片，没有视觉焦点，槽位还是 9 列表格。
这一版换了构图：

- **槽位机架条是主视觉**：每台设备的模块画成一排机位（上面是槽号，中间是功能面 `IM/AI/DI/DQ/F-RS`，
  下面是物理名 `1200MOD2`），点一格看它的订货号、地址窗口、通道数与 F 参数。机位条横向滚动，
  溢出时右缘渐隐 + 显示滚动条（不是隐藏）。
- **设备列表按角色分组**：控制器 / 分布式 I/O / 驱动 / 第三方 / 网络设备，左侧 `PLC/IO/DRV/GSD/NET`
  方牌，先回答"这是什么"，再回答"是什么型号"。
- **信息分三层**：站点头（名字 + 型号 + 一排标识 chips）→ 机架条 → 选中槽位明细；网络与信号降为
  两列次要信息，不再各占一张卡。
- **排版承担辨识度**：标题与节标签用 DIN 系字形（`Bahnschrift`），所有标识符（订货号、IP、
  通道名、地址）用等宽（`Cascadia Mono`）。不引入外部字体，跟随宿主可用字体回退。
- **一处编排过的动效**：机位条逐格 18 ms 错峰入场，选中槽位明细 200 ms 淡入；`prefers-reduced-motion`
  下全部关闭。

色彩仍是中性为主 + 单一强调色（选中/交互），绿只表示"I/O 在位"，琥珀只表示"未导出/安全模块"，
全页三个色相。分隔条可拖（`--hw-split`，键盘 ←/→ 亦可），容器查询阈值仍是 **760px**（单栏↔双栏）
与 **520px**（工程名换行）。

上一版验收反馈的逐条对应：

| 反馈 | 现在的做法 |
|---|---|
| 配色花里胡哨 | 中性为主，三个色相各有唯一语义，只用于标签/圆点/选中边 |
| 缩小后没滚动条、溢出被隐藏 | 每个面板自滚动；机位条显式横向滚动；统计条改为换行而非隐藏 |
| 原生下拉颜色乱 | 自绘下拉 |
| 全屏分隔不可调 | 可拖分隔条 |
| 颜色太少、区分性不足 | 角色方牌 + 功能性色相 |
| 指纹改成 pills | 标识 chips（型号/固件/组/接口/子网）+ 槽位 `F` 标记，`title` 里给全量 |
| 列表项信息靠右上、只显示当前值 | 右侧顶部对齐（IP + 槽数）；页脚只显示当前 AML 校验和前 12 位 |

## 已知的取舍

- 设备详情里的信号只显示前 8 条（Signals 视图可搜索全部 356 条）；控制器那侧显示的是**它拥有的标签映射**，
  IO 设备那侧显示的是**它拥有的通道映射**，两者是同一批数据的两个方向。
- 模块参数只在 F 模块上展示：标准 I/O 模块的参数在 Openness V17 里要么不发布、要么只是枚举索引
  （见 `packages/dsh-tia-openness-v17-min/docs/HARDWARE-PARAMETERS-PLAN.md` §8）。
- `*.png` 与 `*.json` 是渲染/抓取产物；若这个目录进 git，建议 ignore，只留
  `page.tpl.html` / `gen.mjs` / `README.md`。