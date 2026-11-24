# @automation-suite/ui-hardware

右侧栏 **Hardware** 标签页：把 TIA 工程导出的硬件组态渲染成「工程机架」。

**它不读 XML、不连 TIA、不新增 HTTP 路由。** 宿主半侧只有一个空 `apply()`，存在的意义是让 Loader
有一行可扫（浏览器半侧只有在启用的行声明了本包时才会去要 `lib/client.js`）。数据来自
`<workspace>/.dsh/hardware-view.json` —— 由 `@automation-suite/tia-openness-v17` 的 `hardware_view`
工具解析 CAx/AML 之后写出；本插件只读这份派生视图。

## 视图内容

| 区块 | 说明 |
|---|---|
| 统计条 | 设备 / 模块 / 通道 / 子网 / 信号 / 未导出 |
| 设备列表 | 按角色分组：控制器、分布式 I/O、驱动、第三方、网络设备、上位机、其他；搜索覆盖设备名、模块、订货号、信号 |
| 机架条 | 每台设备的模块排成一排槽位（槽号 + 功能面 + 物理名），点一格看明细 |
| 槽位明细 | 订货号、地址窗口、通道数；F 模块额外显示 F 参数 |
| 网络 / 连线 | 接口、IP、掩码、PROFINET 名、子网，以及 port↔port、node→subnet、interface→IO system 的连线计数 |
| 信号映射 | 通道 → 标签；CPU 侧是标签映射、IO 侧是通道映射（同一批数据的两个方向），只显示前 8 条 |
| 页脚 | AML 快照校验和（前 12 位）、大小、生成时间 |

## 状态

- 加载中；还没有视图（`hardware-view.json` 不存在）；读取失败（文件在但解析不了或读取被拒）——
  后两者都给「重新读取」按钮
- 搜索无匹配、未选槽位时各有空态
- CAx 跳过的对象仍会出现在列表里，标为「未导出」并说明原因（它存在于工程里，但不在 AML 中）

## 跟随宿主

- **语言**：中文 / English 跟随 DSH 语言设置切换，不需要刷新
- **配色**：只用宿主语义 token，不自带一份主题
- **宽度**：容器查询 —— 面板 < 760px 时单栏并出现设备选择器，≥ 760px 双栏，≥ 900px 网络与信号分两列，
  < 520px 顶部操作换行
- `prefers-reduced-motion` 下关闭动效

## 安装

作为 bundle 使用：`cordis.patch.yml` 插一行 `id: ui-hardware` / `name: '@automation-suite/ui-hardware'`，
profile 的 `dependencies` 与 `dsh.profile.bundles` 各加一条同名条目。

```jsonc
"dependencies": { "@automation-suite/ui-hardware": "0.1.0" },
"dsh": { "profile": { "bundles": ["@automation-suite/ui-hardware"] } }
```

## 开发与验收

```powershell
node scripts/build.mjs      # lib/index.js + lib/client.js（esbuild）
node scripts/run-tests.mjs  # 先构建再跑：视图解析 / 筛选 / 槽位 / 字典 / 格式化
```

浏览器半侧靠真实 dev-env 验收：打开右侧栏 Hardware，确认有 `.dsh/hardware-view.json` 的工程能渲染出机架、
缩窄面板时切到单栏并出现设备选择器、切语言与主题都不需要刷新。

## 限制

- 数据由 TIA 插件生成；本插件不探测工程、不读 AML，所以没有视图文件时只给空态与提示。
- 信号列表按设计只显示前 8 条；完整数据用 Signals 视图搜索。
- 标准 I/O 模块的参数在 Openness V17 里要么不发布、要么只是枚举索引，所以只有 F 模块展示参数。
