# 读一段 LAD 的固定顺序

> 适用：`@automation-suite/engineering-graph` 的 `knowledge_*` 工具。
> 这份文档解释**怎么读**。工具保证的是"事实"（结构、读写、扫描序），不是结论。

## 1. 五个角度，各回答什么

| 角度 | 工具 | 能确定的事实 | 不能确定的 |
|---|---|---|---|
| 结构 | `knowledge_network(view='ladder')` | 哪个线圈、由哪些条件（与/或）达成 | 盒指令内部算什么 |
| 数据流 | `knowledge_network` 的 `Writes/Reads` | 这个网络读写了哪些变量 | 谁在别处也写它 |
| 扫描时序 | `knowledge_variable_usage` 的 `Scan order` | 读到的是同拍还是上一拍；多个写入谁赢 | 跨块顺序（依赖调用链） |
| 业务意图 | 网络标题、变量名、注释 | 这段在工艺上做什么 | 是否符合安全规范 |
| 验证 | 仿真/在线监控 | 运行时的真实值 | — |

## 2. 读取顺序

1. `knowledge_block` 列出网络与索引，先看**写集合**定位到相关网络，不要从头读。
2. 对候选网络用 `view='ladder'` 读结构：
   - **同一个线圈出现多行 = 这些条件互为或关系**（并联分支）；
   - 一行内的 `AND` = 串联条件；
   - `NOT x` = 常闭触点；
   - `(=)` 赋值、`(S)` 置位、`(R)` 复位、`(/)(=)` 取反线圈；
   - `-- (no coil)` = 该路径不通向线圈（EN 链、报警接线、空分支）。
3. 涉及"这个值什么时候是新的"时，用 `knowledge_variable_usage`：
   - `read at N runs after write at M — same scan`：读到的是本拍新值；
   - `read at N runs before write at M — it sees the PREVIOUS scan's value`：**读的是上一拍**；
   - `written at ... — the later network wins`：多处写，扫描序靠后者生效；
   - `never written in this database`：值来自 HMI/硬件/不在库里的块。
4. 需要跨块时，先确认调用关系（`knowledge_query` 查 `CALLS` 边），再判断谁先执行。

## 3. 三条红线

1. **`Ladder view: not available`** 时不要猜结构，那可能是 SCL 区域或旧库；用语句文本读。
2. **含盒指令（`Move`、比较、计时器、`Call`）的网络**，阶梯视图只把盒子标成一步，它内部的条件在它自己的网络里。不要把它当成一个普通触点。
3. **阶梯视图给的是"条件"，不是"值"**。取反线圈已标注 `(/)(=)`；置位/复位是保持型，不能按"等于条件"理解。

## 4. 常见误判

| 误判 | 事实 |
|---|---|
| 把并行分支读成串联 | 同一线圈多行才是并联 |
| 把 `(S)`/`(R)` 当赋值 | 它们是保持型，条件为真时置位/复位一次 |
| 忽略一拍延迟 | 生产者网络号大于消费者网络号时，读到的是上一拍 |
| 把实例 DB 成员当变量 | `G_PLS_Transfer_Cav_A.Mvt_VocDoor_Ask` 是块接口，写入方是那个块 |
| 认为一处写入就是唯一写入 | 用 `knowledge_variable_usage` 查全部写入者 |

## 5. 这些结论来自哪里

- 结构规则由 TIA V17 实测确定（`docs/research/tia-lad-structure-rules.md`）：线圈可在分支中间、嵌套分支、扇出、取反触点、同位 S/R 双写均合法。
- 阶梯视图与语句翻译的一致性由等价校验保证（reference 工程 1323 个线圈零分歧）。
- 扫描序是 IEC 61131-3 语义：块内网络自上而下执行一次，后写者胜。
