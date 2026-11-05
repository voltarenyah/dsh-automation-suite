# Capability wall — 词墙文案（中英对照）

首页演示面板里的全部词条与文案。**这份文件就是词墙的唯一文案来源**，改它就等于改页面，改完发回来我同步。

规则（改的时候留意这三条）：

1. **左边英文是页面上真正显示的文本**，右边中文只是给你对照/备用，不会出现在英文页面上。
2. 结尾带 `*` 的英文词条 = 路线图项（页面上会显示一个靛蓝星号，底部有图例）。摘掉星号 = 当作已具备的能力。
3. `★` = 大字锚点（页面上字号最大、且不会被排版裁掉）。建议保持 5–7 个，太多就没有层次了。

判定标准：**懂 TIA Portal 的人看到这个词，能指出它在软件里对应哪个东西**（块类型、表、对话框、设备状态）。做不到的不要放进来。

---

## 1 · TIA Portal 对象与操作

| English（页面显示） | 中文对照 | 标记 |
|---|---|---|
| TIA Portal V17 | TIA 博途 V17 | ★ |
| TIA Openness | TIA 开放接口 | ★ |
| Export blocks | 导出块 | ★ |
| Import blocks | 导入块 | |
| Compile PLC | 编译 PLC | ★ |
| Generate source | 生成源文件 | |
| External source | 外部源文件 | |
| OB · FB · FC · DB | 组织块 · 功能块 · 功能 · 数据块 | |
| UDT | 用户自定义数据类型 | |
| Tag tables | 变量表 | |
| Watch tables | 监控表 | |
| Force tables | 强制表 | |
| Project archive | 项目归档（.zap17） | |
| Project library | 项目库 | |
| Master copy | 主副本 | |
| Type version | 类型版本 | |
| Software units | 软件单元 | |
| Know-how protection | 专有技术保护 | |
| Safety signature | F 签名 | |
| Project languages | 项目语言 | |
| Open in block editor | 在块编辑器中打开 | |
| Save as | 另存为 | |

## 2 · 读懂一个工程

| English（页面显示） | 中文对照 | 标记 |
|---|---|---|
| Call structure | 调用结构 | |
| Cross references | 交叉引用 | |
| Variable usage | 变量使用位置 | |
| Block search | 块搜索 | |

## 3 · 版本

| English（页面显示） | 中文对照 | 标记 |
|---|---|---|
| Version control | 版本控制 | ★ |
| Version history | 版本历史 | |
| Git diff | Git 差异 | |
| Project translation | 项目翻译 | |

## 4 · 仿真

| English（页面显示） | 中文对照 | 标记 |
|---|---|---|
| PLCSIM Advanced | PLCSIM Advanced 仿真 | ★ |
| Power on / off | 上电 / 断电 | |
| RUN / STOP / reset | 运行 / 停止 / 复位 | |
| Tag read / write | 变量读写 | |
| Snapshot / restore | 快照 / 恢复 | |
| Retained data | 保持性数据 | |
| Softbus / TCP-IP | 虚拟总线 / 网卡通信 | |

## 5 · 面板

| English（页面显示） | 中文对照 | 标记 |
|---|---|---|
| PLC blocks panel | PLC 块面板 | |
| TIA console | TIA 控制台 | |
| Drawing search | 图纸检索 | |

## 6 · 路线图（带星号）

| English（页面显示） | 中文对照 | 标记 |
|---|---|---|
| TIA Portal V18* | TIA 博途 V18 | 路线图 |
| Hardware config* | 硬件组态 | 路线图 |
| Online & download* | 在线与下载 | 路线图 |
| Compare blocks* | 块比较 | 路线图 |
| Project diff* | 工程差异 | 路线图 |
| Cable & terminals* | 电缆与端子表 | 路线图 |

---

## 7 · 面板上的其它文案

| English（页面显示） | 中文对照 | 位置 |
|---|---|---|
| Capability map | 能力地图 | 左上角小标签 |
| hover a term | 悬停查看 | 右上角提示 |
| * on the roadmap, not shipped yet | * 路线图项，尚未发布 | 左下角图例 |

---

## 当前统计

- 共 46 个词条：40 个已具备 + 6 个路线图项
- 6 个锚点（★）：TIA Portal V17、TIA Openness、Export blocks、Compile PLC、Version control、PLCSIM Advanced
- 英文页面只显示左列；要加词就在对应分组里加一行，中英都填上
