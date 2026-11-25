# 真机验收：TIA 关掉之后提交（D41 的"未验"项）

- 日期：2026-11-25
- 状态：**已验收通过**（真机 TIA Portal V17 + 生成的 workspace + 真实 git）
- 相关：[`decisions.md`](../decisions.md) D41（提交不再要求 TIA）、D42（版本管理独立成包）、
  [`version-control-plan.md`](../version-control-plan.md) §7
- 被测会话：`session-51a814b0-af7e-4580-8210-cf8e553fc97b`（leader）+
  `a0e01aa2-…`（auditor-baseline）+ `33d357c9-…`（auditor-sync1）
- 工作区：`C:\Users\Ansel\Documents\dsh-automation-suite\0.2.5\versioncontroltest`
- 源工程：`PEI_SinoARP_SWT2.ap17`（1155 块 / 215 类型 / 7 标签表）

---

## 1. 结论

1. **R1 通过**：TIA 关掉（`projectOpen:false`）之后，`project_commit` 仍然完成**计划与真实提交**——
   设备从 `source/` 的索引解析（`deviceOrigin` 走 index 路径），只是附一句警告，不再有
   `tia_access_unavailable` / `tia_project_not_open`。**这是 S0 的唯一实质目标，现已真机实证。**
2. **③ 层整条链路通过**：create 的基线提交经 `versionControl` 服务完成（git init + 一次提交 + 账本回放），
   之后的 commit 自动记 1 条变更事件；`project_history` 能按块答出"哪个面变了"（Code + Comments）。
3. **性能上没有再出现"交叉校验可能挂死"的风险**：TIA 关闭时 `project_commit` 计划 619 ms、
   真实提交 1677 ms。控制器没有被超时终止（同一会话后续 `project_status` 仍在用它的缓存状态）。
4. 发现 4 个**非阻塞**问题（§6），都不影响这次拆分，但值得在发布前处理。

---

## 2. 跑过的步骤（全部经 GUI 会话，不是脚本直调）

| # | 谁做 | 动作 | 耗时 |
|---|---|---|---|
| 1 | leader → auditor-baseline | `create_engineering_project(.ap17, dry_run:false)` | 约 8 分钟（TIA 打开 + 另存 + 导出 1376 对象） |
| 2 | auditor-baseline | `project_status(verify:true)` | 6.4 s |
| 3 | 用户 | 在 TIA 里改 `000_Main_PC`（Code + 注释）并保存 | — |
| 4 | auditor-sync1 | `project_sync(force:true)` → **失败 `needs_compile`**（改完未编译） | 7.5 s |
| 5 | leader | `compile_plc(Sino_PEI)` → 0 error / 10 warning | 17.9 s |
| 6 | auditor-sync1 | `project_sync(force:true)` 重试 → 1 changed，3 路径待提交 | 83.8 s |
| 7 | 用户 | **完全退出 TIA Portal** | — |
| 8 | auditor-sync1 | `project_commit(message:"Modify OB")` 计划 | 619 ms |
| 9 | auditor-sync1 | `project_commit(dry_run:false)` 真提交 | 1677 ms |
| 10 | auditor-sync1 | `project_history(commit:"715de4d")` | 35 ms |

步 4 的 `needs_compile` 是**设计行为**（checksum 只覆盖已编译程序），不是缺陷：
它把"改完先编译"这一步显式化了。

---

## 3. 关键证据（原始输出摘录）

**步 1 — 基线提交由服务完成**（计划里的措辞就是 `planBaseline` 返回的 `description`）：

```
create_engineering_project: Saved PEI_SinoARP_SWT2 into tia/versioncontroltest/ and wrote 1376 object(s)
into source/, 1 refused by TIA. The knowledge graph was not built. The import is committed as the git baseline.
Git: …\versioncontroltest is not a repository yet — it will be initialized (git init -b main) after the import,
     and a baseline commit will be created for source/, .gitignore and .gitattributes.
Refused: Sino_PEI/blocks/FOB_SAFETY — export_failed: … The export of block 'FOB_SAFETY' is not permitted.
```

**步 8 — TIA 关闭后的计划**（核心断言）：

```
project_commit: Dry run: would commit 3 path(s) under source/Sino_PEI.
PLC: Sino_PEI / Sino_PEI → …\versioncontroltest\source\Sino_PEI
Evidence: 1377 object(s), state sha256:ee918d2a…, checksum EA 8D EE FC 9C 9C E8 D6.
Message that would be recorded:
  Modify OB
  Tia-Op: sync
  Tia-Checksum: EA 8D EE FC 9C 9C E8 D6
  Tia-State: sha256:ee918d2a…
  Tia-Manifest: updated
Warnings (1):
  - TIA has no project open; the device was taken from the source tree.
```

**步 9 — 真实提交**：

```
project_commit: Committed 715de4d5987d297cdd04bc13879ebb09f87935c2: 3 path(s) under source/Sino_PEI.
Commit: 715de4d5987d297cdd04bc13879ebb09f87935c2 (3 path(s)).
Version store: 1 change event(s).
Warnings (1):
  - TIA has no project open; the device was taken from the source tree.
```

---

## 4. 独立落盘核对（不依赖 agent 自述）

**git**

```
715de4d Modify OB
d25aafc create: PEI_SinoARP_SWT2 — baseline import of the exported source tree

# HEAD 的 message 尾部
Tia-Op: sync / Tia-Checksum: EA 8D EE FC 9C 9C E8 D6 /
Tia-State: sha256:ee918d2a… / Tia-Manifest: updated

# HEAD 只含 3 个路径（路径限定成立）
source/Sino_PEI/_evidence.json
source/Sino_PEI/_manifest.json
source/Sino_PEI/blocks/00_Common_Part/000_Main_PC.xml

# 工作树干净
（git status --porcelain 空）

# trailer 与账本一致
_evidence.json: plcChecksum = EA 8D EE FC 9C 9C E8 D6，stateId = sha256:ee918d2a…
```

**版本库 `.dsh/versions.db`（5.7 MB）**

| 表 | 行 | 内容 |
|---|---|---|
| `versions` | 2 | `d25aafc` op=create（parent NULL）→ `715de4d` op=sync（parent `d25aafc`） |
| `change_events` | 1 | `blocks\|00_Common_Part\|000_Main_PC`，change=modified，faces=`["Code","Comments"]`，前后指纹只有这两个面不同 |
| `block_timeline` | 1 | 同块 seq=1，subject `Modify OB`，faces 同上 |

**投影 `.dsh/versions-view.json`**：`counts = {versions:2, events:1, baseline:1377}`，
两个版本都带 subject 与事件数 → **基线的回放也回写了投影**（这是 S2b 顺手修的那个缺陷的正向验证）。

**归属标记 `.dsh/local/repo.json`**：`{schemaVersion:1, createdBy:"engineering-context"}` ——
标记的写入方换成了 `version-control`，但值保持旧身份，所以旧工作区不会被当成"外人的仓库"。

---

## 5. 这次顺带验证到的边界

- **安全块导不出**：`FOB_SAFETY` 被 TIA 以 `export_failed ... not permitted` 拒绝，create 把它记成
  refused/unexportable 后**继续成功**（1376/1377），不因单个块失败而回滚整次导入。
- **图谱缺席 / 引擎不可用是 fail-soft**：`knowledge_engine_unreachable engine_exited`（本机缺 .NET 10 的
  apphost 解析，见根 `AGENTS.md` §4），create 只报 "The knowledge graph was not built"，
  导入与提交照常完成。
- **`tia-todo-bridge` 在真实流程里按设计工作**：每次 TIA 操作完成后都追加一条 model-visible 的
  settlement notice，逼模型把 Todo 项收尾（会话里能看到 7 次 `todo_write`）。

---

## 6. 发现的问题（都不阻塞本次拆分）

| 级别 | 问题 | 证据 | 建议 |
|---|---|---|---|
| **P2** | 警告文案不能区分"TIA 已退出"与"TIA 开着但没开工程" | 真机上 TIA 已退出，文案仍是 "TIA has no project open" —— 因为 `readTiaSession().running` 表示**控制器活着**，不是 TIA 活着 | 改成 "TIA is not running, or has no project open; the device was taken from the source tree."（一行文案 + `test/16` 断言） |
| **P2** | 安全块被拒后 source 树缺一个块，但账本仍报 1377 个对象 | `create` 报 "1 refused"；`project_status` 报 `Evidence: 1377 object(s)`；`workspace_describe` 报 `evidence 1376 object(s)` | 两个工具用同一个词表示不同口径：账本条目数 vs 已落盘对象数。统一措辞或分别命名 |
| **P3** | 图谱引擎在本机跑不起来 | `engine_exited` + stderr 里的 `8.0.34`（apphost 找 `C:\Program Files\dotnet`，而 .NET 10 在 `%USERPROFILE%\.dotnet10`） | 既有环境问题；`start-env.ps1` 起 dsh 时应把 `DOTNET_ROOT` 传进去（或 doctor 检查并提示） |
| **P3** | 首次同步必失败一次（`needs_compile`） | 步 4 的 7.5 s 失败 → 编译 → 重试 | 设计如此；但 leader 的提示词可以更早说"改完先编译"，少一次往返 |

---

## 7. 没覆盖到的（仍算"未验"）

1. **TIA 开着但打开的是另一个工程**：`crossCheckDeviceWithTia` 的 mismatch 分支只在单测里验过，
   真机没跑（需要另一个工程）。
2. **`version-control` 缺席时 create 的 fail-soft**：单测覆盖（`test/02`），真机没跑
   （要临时从蓝图移除 bundle 再重建 profile）。
3. **多设备工作区**：本次是单 PLC；`multiple_plc_unsupported` + `device:` 参数的真机路径未跑。

这三条的风险都不高（前两条有单测、第三条是显式参数），可以等下一次真机窗口一起补。
