# 仿真快照的工作区存储与复用（Case A）

> **状态：已落地（2026-11-17，决策 D37）** · 取代 2026-11-16 草案中的 Case B 范围
> 实现：`packages/dsh-plcsim-advanced`（manifest v2 + `snapshot_remove` + TS provenance/stale）
> 关联：`docs/simulation-plcsim-advanced.md`，`packages/dsh-plcsim-advanced/AGENTS.md` §6，
> 根 `AGENTS.md` §7.1 / §7.2
>
> **2026-11-17 范围收紧**：专项仿真项目（一个测试任务一个 TIA 工程）**暂缓**。
> 当前只做「受管工程直接下载到虚拟 PLC」这一条链路，并把 PLCSIM Advanced 快照
> **在工作区内落位、能被列出、能在下次会话调出来**。Case B 的评估保留在 §8，不实现。

---

## 0. 结论（TL;DR）

1. **同意暂缓 Case B**：现在只有一个 TIA 实例（同时只能开一个可编辑工程），
   而"独立仿真工程从哪来、测试完怎么退役、和受管工程怎么同步"都没有稳定答案；
   先做会制造第二套工程生命周期，比不做更贵。
2. **快照存储其实已经基本具备**（0.2.5 起）：`<workspace>/.dsh/simulation/<snapshot>/`，
   含 `instance.zip` + `storage/` + `manifest.json`；`resume` 可跨 DSH 重启直接启动，
   不需要重新下载、不需要再次接受证书。
3. **现在缺的不是"找地方"，而是四件小事**：
   - 快照**记下它来自哪个受管工程、哪个编译校验和**（否则 resume 的是旧程序也没人知道）；
   - `snapshots` / `resume` 结果里**显示这层绑定**，并在校验和变化时警告"快照比当前源树旧"；
   - **删除/清理快照**的动作（现在只能覆盖，不能删）；
   - 把位置、命名、机器/版本绑定写进文档和 `AGENTS.md`（位置不变，`.dsh/simulation/`）。
4. **位置保持 `.dsh/simulation/` 不变**：它已经跟着工作区走、已在 `.gitignore` 里、
   已有的快照不用迁移。若要"更显眼"，优先在 `project_status` / 面板里显示，而不是搬目录。
5. **不新增工具**：只扩 `simulation_instance` 的 `snapshot_remove` 动作和快照 manifest 字段。

---

## 1. 现状核对：已经能做到什么

| 能力 | 现状 | 位置 |
|---|---|---|
| 快照落点跟着会话工作区 | ✅ `<workspace>/.dsh/simulation/<snapshot>/` | `packages/dsh-plcsim-advanced/src/workspace.ts:18,43-61` |
| 快照内容 | ✅ `instance.zip`（官方归档：程序+硬件+保持数据）、`storage/`（快速副本）、`manifest.json` | `controller/Program.cs:198-289` |
| 跨会话/重启复用 | ✅ `resume`：活实例就 attach；否则复制 `storage/`；旧快照回退 ZIP | `controller/Program.cs:291+` |
| 首次证书问题 | ✅ `resume` 沿用原设备身份，跳过证书与重新下载 | `AGENTS.md` §7.2 |
| 先扫描再新建 | ✅ 工作区有快照时 `create` 拒绝，要求用户选"旧快照 or 新实例" | `controller/Program.cs:127-139` |
| 列出快照 | ✅ `simulation_instance(action="snapshots")` / `simulation_status` | `src/tools.ts:231-247,252-367` |
| git 隔离 | ✅ `.dsh/` 已被工作区 `.gitignore` 覆盖 | `@automation-suite/engineering-context/src/config.ts:223-225` |

**结论：不需要另起一套存储。** 需要补的是"快照的身份"和"快照的生命周期"。

现有 `manifest.json` 只记实例坐标（name / cpuType / communication / ip / createdAt /
sourceStoragePath / sourceState / hasStorage），**没有** TIA 工程与编译校验和，
所以：
- 用户改完程序重新下载后，旧快照仍然"看起来一样"，`resume` 会静默跑旧程序；
- 换机器/换 PLCSIM 大版本后，快照为何不能复用也没有可读证据；
- 快照越攒越多，没有删除入口。

---

## 2. 决定：暂缓专项仿真项目（Case B）

### 2.1 理由

1. **单 TIA 实例**：Openness 一个 `TiaPortal` 实例同时只有一个可编辑工程
   （secondary 工程只读，不能下载）。做多个仿真工程意味着频繁关/开工程，
   与当前「一个 workspace 一个受管工程」的作用域模型直接冲突（D5/D22）。
2. **来源与生命周期未定**：
   - 工程从哪来？整份复制后裁剪、用户自建后收编、还是从源树导入？三种路线对
     "哪些块算测试范围、依赖怎么算、硬件怎么来"要求完全不同（V17 工具面没有创建/导入
     硬件设备的能力，只能整份复制）。
   - 测试完怎么办？删除、归档、还是并入受管工程？谁来保证它不漂移？
   - 与受管工程的同步策略（重建 vs 增量导入）没有真实使用数据支撑。
3. **收益可以先由"快照"拿到**：同一受管工程 + 多个命名快照，已经能覆盖
   "基线程序 / 改动前 / 故障注入后"这类复用需求，而且不需要第二套工程。
4. **代价不对称**：先做错的生命周期，后面要迁移用户工程、快照与文档；
   而快照硬化是纯增量、可回退。

### 2.2 重新评估的触发条件（满足其一再启动 Case B）

- 用户明确报出"同一受管工程需要两套互不影响的测试程序"的真实场景；
- TIA Openness 支持可创建/导入硬件组态，或支持同时打开多个可编辑工程；
- 快照方案被证明不够用（例如需要不同硬件/网络配置的测试）；
- 有跨项目复用的真实需求（届时再谈 export/import）。

---

## 3. 快照存储契约（本方案定稿的部分）

```
<workspace>/
└── .dsh/
    └── simulation/                     # 快照根，随工作区走；git 忽略
        ├── <snapshot>/                 # 一个快照一个目录
        │   ├── instance.zip            # PLCSIM 官方归档（权威）
        │   ├── storage/                # 快速启动副本（可重建）
        │   └── manifest.json           # 快照身份 + 来源绑定
        └── ...                         # 多个快照平铺
```

规则：

- **快照名**：单段名字，字母/数字/`-`/`_` 为主；`profiles` 等未来保留名禁止使用
  （即使 Case B 暂缓，也先把命名空间留出来）。重名默认拒绝，`overwrite=true` 才覆盖。
- **权威内容是 `instance.zip`**：`storage/` 只是加速副本，丢了可以从 ZIP 恢复；
  ZIP 与 `storage/` 必须同时属于同一个快照。
- **绑定范围 = 当前工作区 + 当前机器 + 当前 PLCSIM Advanced 大版本**：
  快照不能承诺跨大版本、跨机器直接复用；换环境时按"重新下载 + 重新快照"处理。
- **不进 git**：`.dsh/` 已忽略；不要把快照拷进 `tia/` 或 `source/`。
- **一个工作区一个受管工程**：快照不记录"属于哪个仿真项目"，只记录"来自哪个受管工程 +
  哪个编译校验和"。

### 3.1 扩展后的 `manifest.json`

```jsonc
{
  "schemaVersion": 2,
  "name": "Sino_PEI",
  "cpuType": "CPU1515",
  "communication": "tcpip",
  "ip": "192.168.0.1",
  "subnetMask": "255.255.255.0",
  "gateway": "0.0.0.0",
  "createdAt": "2026-11-17T09:40:00Z",
  "sourceStoragePath": "…",
  "sourceState": "Run",
  "hasStorage": true,

  // 新增：来源绑定（读不到就写 null，不猜）
  "source": {
    "projectName": "demo",
    "projectPath": "tia/demo/demo.ap17",   // workspace 相对路径
    "device": "Sino_PEI",
    "software": "Sino_PEI",
    "checksum": "0F3A…",                   // 下载/编译时的 PLC checksum
    "stateId": "…",
    "capturedAt": "2026-11-17T09:39:00Z"
  },
  "runtime": {
    "plcsimVersion": "7.0.323.0",
    "apiVersion": "4.0"
  }
}
```

填写方式（按可靠性排序）：

1. **控制器能读到的**（PLCSIM 版本、CPU、通信、IP、存储路径）由控制器直接写；
2. **TIA 工程/校验和**：优先由 TS 侧只读工作区里的
   `source/_dsh-engineering-context.json`（工程身份）与 `source/<device>/_evidence.json`
   （最近一次编译校验和），读不到就写 `null`；
3. 也允许调用方显式传 `source_project` / `source_checksum` 覆盖（用于测试或特殊流程）。

> 只读这两个文件是**约定耦合**，不是服务依赖；文件缺失/格式变化时降级为 `null`，
> 绝不让快照动作失败。

### 3.2 为什么要绑定校验和

- `resume` 的目标是"快速回到某个已知程序状态"。没有校验和，就无法回答
  "这个快照对应的是哪一版程序"。
- 有了它，`snapshots` 可以显示：
  `baseline ← checksum 0F3A… (2026-11-17 09:40, tcpip/192.168.0.1)`；
  当前源树 checksum 不同则标 `stale: true` 并提示"快照比当前程序旧"。
- 这是**警告，不是拦截**：用户可能就是想回到旧程序。

---

## 4. 已落地的四件事

### 4.1 快照写入时记录来源（控制器 + TS）

| 层 | 改动 |
|---|---|
| 控制器 `Snapshot()` | manifest 增加 `source`（由请求参数透传）与 `runtime`（Runtime 版本、API 版本）；`schemaVersion` 升 2 |
| TS `simulation_instance` | `snapshot` 动作组装 `source`：读工作区 `source/_dsh-engineering-context.json` + 对应 `_evidence.json`；允许 `source_project` / `source_checksum` 覆盖 |
| 列表 | 现有 `SnapshotList` 会把 manifest 其余字段原样带出（`Program.cs:491-510`），新增字段自动可见 |

### 4.2 列表/恢复时显示绑定与漂移

- `snapshots` 每行增加：`sourceProject`、`checksum`（短）、`runtime`、
  `stale`（与当前 evidence checksum 比较；无证据时 `unknown`）。
- `resume` 结果带一行 `Key facts:` 已有机制，补 `snapshot=… checksum=… stale=…`；
  stale 时附一句"这个快照对应旧程序；要继续用它，还是先重新下载再快照？"
- 不改变 `resume` 的默认行为（用户明确要旧快照就照做）。

### 4.3 删除快照（新增动作）

- `simulation_instance(action="snapshot_remove", snapshot="<name>", confirm=true)`。
- 删除目标必须是快照根下的**单层**目录（`ResolveSnapshotDirectory` + `DeleteDirectory`
  沿用现有越界保护 `Program.cs:899-902`），不跟随链接。
- 默认只删一个；`all=true` 需要二次确认（或不做，留给以后）。
- 与 `remove`（删实例）语义分开：`remove` 不碰快照，`snapshot_remove` 不碰实例。

### 4.4 文档与行为口径

- 根 `AGENTS.md` §7.2 补一句：快照在 `<workspace>/.dsh/simulation/`；先 `snapshots`
  再问用户；`resume` 跳过证书；快照绑定当前程序校验和。
- `packages/dsh-plcsim-advanced/README.md` / `AGENTS.md` §6 记录 manifest v2 字段。
- 不在本方案里改 UI 面板；若要把快照显示在 `project_dashboard`，单独立项。

---

## 5. 工具面变化（很小）

| 工具 | 变化 |
|---|---|
| `simulation_instance` | 新增 action `snapshot_remove`；`snapshot` 接受可选 `source_project` / `source_checksum`；`snapshots` / `resume` 渲染补快照身份 |
| `simulation_status` | 不用改（已透传快照列表） |
| 其它 | 无新增工具、无新增插件、无 preset 变化 |

> `snapshot_remove` 只加一个 action，不拆新工具：与现有 `simulation_instance` 的
> action 风格一致，也不改变 preset 工具数。

---

## 6. 明确不做

- 不做专项仿真项目（Case B）：见 §2 与 §8。
- 不做快照跨机器/跨工作区导出导入（需要时再立项）。
- 不做自动快照策略（每次下载后自动存、保留 N 份）——先让用户显式命名。
- 不把快照纳入 git。
- 不改受管工程 `tia/` / `source/` 的既有布局。

---

## 7. 验收

1. `simulation_instance(snapshot, name=..., snapshot="baseline")` 后
   `manifest.json` 含 `schemaVersion: 2`、`source.checksum`、`runtime.plcsimVersion`。
2. 重开 DSH → `simulation_instance(action="snapshots")` 仍列出该快照，且带 checksum；
   `resume` 成功启动，无需 TIA、无需证书。
3. 在 TIA 里重新编译/下载后，`snapshots` 把旧快照标 `stale: true`，`resume` 仍可用但提示。
4. `snapshot_remove` 不带 confirm 被拒；带 confirm 后目录消失，实例不受影响；
   快照根之外的路径被拒。
5. 既有快照（manifest v1，无 `source`）仍能列出和 `resume`，显示 `checksum unknown`。
6. 单元测试覆盖：manifest v1/v2 兼容、source 读取降级、路径越界、stale 判定。

---

## 8. 附录：Case B 的评估结论（保留，暂不实现）

若将来重启专项仿真项目，推荐形态仍是 2026-11-16 草案的方案 B：

- 工程：`tia/sim/<profile-id>/project/` + `simulation.json`；
- 运行态：`.dsh/simulation/profiles/<profile-id>/snapshots/`；
- 创建方式：`archive → close → retrieve`（不用 `SaveAs`，它会移动打开工程）；
- 裁剪：复制后 `delete_plc_objects` + `compile_plc`（V17 无硬件创建/导入能力）；
- 工具：`simulation_project(create/adopt/list/inspect/remove)` + PLCSIM `project` 参数。

重启前必须先回答：

1. 仿真工程的来源（复制裁剪 / 用户自建收编 / 源树导入）与责任边界；
2. 生命周期（测试结束后删除、归档还是并入受管工程）；
3. 与受管工程的同步策略（重建 vs 增量）；
4. 多工程切换时"一个 TIA 实例"的交互约定（谁负责关工程、失败怎么恢复）。

未回答之前，不写代码、不进 preset。
