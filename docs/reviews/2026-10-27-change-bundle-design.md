# 设计 v2：变更包 + 可追溯提交（按 2026-10-27 的三条原则）

> **2026-11-01 架构升级**：git 定位为文件级版本工具，工程层面的版本信息（每块 fingerprint、
> 意图、关联需求、验收）改由 workspace 级 SQLite 记录，见
> [2026-11-01-version-store.md](2026-11-01-version-store.md)。本文的 checksum trailer / tag 讨论
> 保留作为该方案的历史依据（结论：**不用 tag**，checksum 用 trailer，版本库是扩展层）。

> 本文取代 [2026-10-26 复盘](2026-10-26-commit-workflow.md) §3 里"project_diff 输出 network 内容/ST"的提议。
> 复盘的事实与根因仍然有效；**方案按下面的三条原则重写**。仍未改任何代码。

## 0. 三条原则（用户原话，作为约束）

1. **职责边界**：auditor 只管版本与改动涉及的文件；expert 理解程序逻辑。
   两者需要互相调用时，leader 是协调方——**预定义工作流由 leader 直接转接请求**，否则给用户提案批准。
2. **project_diff 的定位**：只解析"改了什么"，**不详细到 XML 文件内部**；但必须明确
   checksum 变化、哪些文件新建/修改/删除；并为 commit 提供 `old checksum`、`new checksum`、
   `modified element`。**提交历史里要能查到每次提交改前/改后的 checksum、动过哪些块、
   以及每块改前/改后的 fingerprint**——这些是 auditor 的核心管理内容。
3. **交接方式**：auditor 解析完 diff 后，把"修改涉及的具体元素"以结构化形式交给 leader；
   leader 原样作为 context 转给 expert。expert 据此**直接访问有变化的 XML 文件本身**——
   这些文件在比较时就被识别出来，并导出到一个固定位置。

（原则 3 末尾在消息里被截断；本文按"expert 读变更包里的 XML"设计，见 §8 待确认。）

---

## 1. 职责矩阵与转接协议

| 动作 | auditor | expert | leader | 用户 |
|---|---|---|---|---|
| open / save / compile / export（TIA 写） | — | — | ✅ | — |
| sync / diff / commit / 图谱刷新 | ✅ | — | 转接 | 批准（提交/刷新） |
| 读变更包 XML（before/after/patch） | ✅（导出） | ✅（只读） | 不读 | — |
| 解释程序逻辑、影响分析 | — | ✅ | 汇总 | — |
| 写 commit message | —（只生成机器字段） | — | ✅（合成） | 批准 |
| 改块（XML 编辑 + import） | — | — | ✅ | 批准 |

**预定义工作流（leader 可直接转接，不打断用户）**

| 触发 | 链路 |
|---|---|
| "我改了东西，告诉我改了什么" | `auditor(diff+bundle)` → leader 汇总 |
| "我改了东西，给我提交信息" | `auditor(diff+bundle)` → `expert(intent)` → leader 合成 → 用户批准 → `auditor(commit)` |
| "为什么/这段逻辑干什么" | `expert`（bundle 或图谱） |
| "提交" | 若已有 bundle：`auditor(commit)`；否则先 `auditor(diff+bundle)` → 用户确认 |

**非预定义（必须给用户提案）**

- expert 想改块 / auditor 想解释逻辑（跨职责写入或越权解读）；
- 需要刷新图谱（有成本：本次实测 58 s、+20 MB、112 组件闭包）；
- amend / rebase / 改写历史；
- 同一工作流里出现第 3 个角色（例如需要新建 preset）。

提案格式（leader 用 `ask_user_question`）：`要做什么 + 为什么 + 成本/风险 + 备选`。

---

## 2. `project_diff` 的输出契约

**只到"文件 + 对象（element）"级，不输出 network/part/text 内容。**
network 级差异由 expert 从变更包的 XML 自行读。

```jsonc
{
  "revisions": { "from": "17f21d4a", "to": "WORKTREE", "fromCommit": "17f21d4a…", "toCommit": null },
  "checksum": { "from": "C0 01 C3 13 58 AC 0E 50", "to": "71 2D DC D7 F9 DF 81 90" },
  "state":    { "from": "sha256:6423dcb8…", "to": "sha256:b3e274af…" },
  "summary":  { "added": 0, "modified": 1, "removed": 0, "elements": 1 },
  "elements": [
    {
      "key": "blocks|01_Cavity_A|100_Cycle_Selection_Cav_A",
      "name": "100_Cycle_Selection_Cav_A",
      "category": "blocks",
      "group": "01_Cavity_A/",
      "path": "source/Sino_PEI/blocks/01_Cavity_A/100_Cycle_Selection_Cav_A.xml",
      "change": "modified",
      "fingerprint": {
        "before": { "Code": "3f1a2b…", "Interface": "91be44…", "Comments": "22e0aa…", "Properties": "d4c0…", "Events": null },
        "after":  { "Code": "8c02d1…", "Interface": "3d7702…", "Comments": "55aabb…", "Properties": "d4c0…", "Events": null }
      },
      "faces": ["Code", "Interface", "Comments"]
    }
  ],
  "bundle": { "dir": ".dsh/changes/17f21d4a..worktree", "manifest": "…/manifest.json", "files": 1 }
}
```

要点：

- `checksum.from` / `state.from` 来自 `from` 修订的 `_evidence.json`（`git show <from>:source/<dev>/_evidence.json`）；
  `to` 来自目标修订或工作树的 `_evidence.json`。diff 模块已有 `readEvidenceAtRevision`，直接复用。
- `fingerprint.before/after` 是 evidence 里每对象 4~5 个 face 的哈希（`diff.ts` 现在只比较、不输出值）；
  `faces` 是其中发生变化的键。
- `elements` 与 `files` 一一对应（一个 XML 文件 = 一个对象）；`added/removed` 时一侧为 `null`。
- 不输出行数？可以保留 `stats: { insertions, deletions }`（git numstat）作为**辅助**，但不解析 XML 语义。
- 工具描述同步改写：`returns checksum/state transition, changed files and elements with before/after
  fingerprints; never the XML content. Pass bundle:true (default) to export the changed files for the expert.`

---

## 3. 提交历史契约（2026-11-01 定稿：checksum 用 trailer，不用 tag）

- **每块 fingerprint 暂不写入提交**（2026-10-28 决定）；`project_diff` 仍输出 before/after
  fingerprint 供复审，但 commit 不写 `Tia-Changed`。
- **每条提交的当前 checksum 用 commit message 的 trailer 记录**（可重复、随提交传播）。
- **不用 tag**：git 的 ref 名唯一，同一 checksum 的第二次提交无法再打同名 tag（§3.2 实测），
  而"同一 checksum 多次出现"是正常场景（改动被还原、编译结果回到旧状态）。
- trailer 保留 checksum/state，并增加 `Prev`，使单条提交自带"改前 → 改后"。

### 3.1 trailers

```text
Tia-Op: sync
Tia-Checksum-Prev: C0 01 C3 13 58 AC 0E 50
Tia-Checksum: 71 2D DC D7 F9 DF 81 90
Tia-State-Prev: sha256:6423dcb8…
Tia-State: sha256:b3e274af…
Tia-Manifest: updated
```

`Tia-Checksum-Prev` 从父提交 evidence 读（见 §3.3）；没有父提交时写 `unborn`。

### 3.2 为什么不用 tag（2026-11-01 评估）

需求是"每次提交标记当前 checksum，同一 checksum 可以出现多次，检索时列出多个"。
tag 做不到，因为 **ref 名在仓库内唯一**。实测（git 2.49）：

```text
$ git tag -a 'AA-BB-CC' -m 'checksum AA BB CC' <c1>   # 成功
$ git tag -a 'AA-BB-CC' -m 'checksum AA BB CC' <c2>   # 同一 checksum，第二次
fatal: tag 'AA-BB-CC' already exists
# exit 128

$ git tag -f -a 'AA-BB-CC' -m '…' <c2>
Updated tag 'AA-BB-CC' (was 4e2bc2f)                 # -f 是"移动"，不是"新增一条"
```

候选方案对比（✅ 满足 / ⚠️ 有条件 / ❌ 不满足）：

| 方案 | 可重复 | 随 clone/fetch/push | `git log` 默认可见 | 检索出多个 | 额外配置 | 结论 |
|---|---|---|---|---|---|---|
| **A. commit message trailer**（`Tia-Checksum:`） | ✅ | ✅ | ❌ 需 `--grep`/`--format` | ✅ | 无 | **采用**（已在用） |
| B. git notes（`refs/notes/*`） | ✅ | ❌ 默认不传 | ❌ 需 `--show-notes` | ✅ | push/fetch refspec | 可选，不默认 |
| C. 自定义 ref（`refs/tia/<checksum>/<sha>`） | ✅ | ❌ 默认不传 | ⚠️ `--decorate-refs` | ✅ | push/fetch refspec | 可选，不默认 |
| D. 提交内文件（如 `.tia/checksums.json`） | ✅（历史版本） | ✅ | ⚠️ 需 `log -p -- <path>` | ✅ | 无 | 体积增长，不采用 |
| E. annotated tag（同名） | ❌ | ✅ | ✅ | ❌ | 无 | **排除** |

**A 的检索（在真实工程里实测）**：

```text
$ git -C <ws> log --all --oneline --grep='Tia-Checksum: 71 2D DC D7'
a5f84d5 feat(cav-a): gate full-cycle request on cooling-table occupancy

$ git -C <ws> log --all --format='%h %ad %s | %(trailers:key=Tia-Checksum)' --date=short
e331d6e 2026-10-26 docs(cav-a): label cooling-table interlock in FR/EN | Tia-Checksum: 86 1D 3F C7 C1 DA 57 67
a5f84d5 2026-10-26 feat(cav-a): gate full-cycle request on cooling-table occupancy | Tia-Checksum: 71 2D DC D7 F9 DF 81 90
17f21d4 2026-10-26 chore: import PEI_SinoARP_SWT2 V17 baseline | Tia-Checksum: C0 01 C3 13 58 AC 0E 50
```

同一 checksum 出现两次时，`--grep` 会列出两行——这正是需要的"多个 item"。

可选的便利 alias（写进工程级 `.git/config`，不提交）：

```text
git config --local alias.tia "log --all --format='%h %ad %s | %(trailers:key=Tia-Checksum)' --date=short"
git tia
```

如果将来确实需要"`git log` 默认就能看到 checksum"，再评估 notes 或 `refs/tia/*`
（本地仓库没有 remote，传播缺点暂时不成立；一旦推远端就要配 refspec）。


### 3.3 old checksum 从哪里来

父提交的 evidence：`git show HEAD~1:source/<device>/_evidence.json`（基线提交则写 `unborn`）。
一次读取即可，**不跑全量 diff**。

### 3.4 trailer 的可读性（现有工程实测）

`git log` 默认只显示 subject，trailer 要用 `--format` / `--grep` 展开；
一旦展开，它就是完整的"每条提交一行 checksum"：

```text
$ git -C <ws> log --format='%h %s%n  %(trailers:key=Tia-Checksum)'
e331d6e docs(cav-a): label cooling-table interlock in FR/EN
  Tia-Checksum: 86 1D 3F C7 C1 DA 57 67
a5f84d5 feat(cav-a): gate full-cycle request on cooling-table occupancy
  Tia-Checksum: 71 2D DC D7 F9 DF 81 90
17f21d4 chore: import PEI_SinoARP_SWT2 V17 baseline
  Tia-Checksum: C0 01 C3 13 58 AC 0E 50
```

`--grep` 同样命中（因为 trailer 就是 message 的一部分）：

```text
$ git -C <ws> log --oneline --grep='Tia-Checksum: 71 2D DC D7'
a5f84d5 feat(cav-a): gate full-cycle request on cooling-table occupancy
```

局限只有一个：`git log --oneline`（默认格式）不显示 trailer。若要在默认视图里"一眼看到"，
只能把 checksum 放进 subject 或引入 tag/notes——前者污染 message，后者需要额外配置（§3.2 已比较）。

### 3.5 与 `project_diff` 的关系

- diff 仍输出 `checksum.from/to`、`elements[].fingerprint.before/after`、`faces`；
- 客户端（leader/expert/用户）可以据此复审，但 **commit 不落盘这些块级 fingerprint**；
- 历史里要查某块改了什么，用 `git show <commit>:source/<dev>/_evidence.json`（权威）+ diff 的 elements 摘要。



---

## 4. 变更包（bundle）

### 4.1 目录

```text
.dsh/changes/<from7>..<to>/
  manifest.json
  before/<device>/<path>.xml     # 仅变更文件
  after/<device>/<path>.xml
  diff.patch                     # 两个版本之间的 unified diff（可选，便于分段读）
```

- 名称：`<from 短哈希>..<to>`，`to` 为 `worktree` 或提交短哈希；
- 只导出**本次 diff 识别出的变更文件**（受 `max_items` 限制，超出的报计数）；
- 旧版本从 git 对象读（`git show <from>:<path>`），新版本从工作树读；`added` 只有 after，`removed` 只有 before；
- `diff.patch` 用 `git diff --unified=3 -- <paths>`，单文件过大时只保留前 N KB 并说明截断。

### 4.2 manifest

```jsonc
{
  "schemaVersion": 1,
  "revisions": { "from": "17f21d4a", "to": "WORKTREE" },
  "checksum": { "from": "...", "to": "..." },
  "state": { "from": "...", "to": "..." },
  "workspace": "C:\\...\\SWT2_PEI_1026_Night",
  "createdAt": "2026-10-27T…Z",
  "files": [
    { "path": "source/Sino_PEI/blocks/…xml", "change": "modified",
      "element": { "key": "...", "name": "...", "category": "blocks", "group": "..." },
      "fingerprint": { "before": {...}, "after": {...} },
      "faces": ["Code","Interface","Comments"],
      "before": "before/Sino_PEI/blocks/…xml", "after": "after/Sino_PEI/blocks/…xml" }
  ]
}
```

### 4.3 生命周期（已确认：只保留最近一次）

- 每次 `project_diff` 写新包前，先清理 `.dsh/changes/` 下**其它目录**（只留这一次的），
  避免"改了 A 又改 B"时包越堆越多；
- 同名目录（同一对修订）直接覆盖；
- `project_commit` 成功后**不**删除（用户可能还要读），下次 diff 时自然被清掉；
- `.gitignore` 忽略整个 `.dsh/`。

### 4.4 谁写、谁读

| 角色 | 权限 |
|---|---|
| auditor | 写（diff 时导出）、读（核对） |
| expert | **只读**，通过专用工具 `change_bundle_read`（见 §6） |
| leader | 不读 XML；只看 manifest 摘要 |

---

## 5. 端到端时序（目标）

```text
用户：我在 TIA 改了 X，给我提交信息
  │
  ├─ leader → auditor：project_sync(dry_run:false) → project_diff(from=HEAD, to=WORKTREE, bundle:true)
  │     auditor 返回：
  │       checksum/state from→to、elements[]（含 before/after fingerprint、faces）
  │       bundle: .dsh/changes/17f21d4a..worktree（manifest + before/after XML + patch）
  │       明确："未提交；这 3 个路径是脏的"
  │
  ├─ leader → expert：上面这份 payload 原样 + "旧图谱是 stale（build at C0 …）；只给意图与影响"
  │     expert 用 change_bundle_read 读 before/after（或 patch）+ 图谱上下文
  │     返回：intent / affected networks / risks / coverage（读了哪些文件）
  │
  ├─ leader → 用户：commit message（含意图）+ 依据（块清单 + checksum 迁移）+ 批准请求
  └─ 用户批准 → leader → auditor：project_commit(dry_run → false)
        auditor 读父 evidence → 写 trailers（Prev/新）→ 提交（不引入 tag）
```

对比 2026-10-26 实际：少 1 次图谱刷新、少 1 次"Hold 再刷再读"往返、expert 不再靠 leader 转述 XML 片段。

---

## 6. expert 的工具：`change_bundle_read`

给 expert 一个**物理上只能读 bundle** 的工具（eng-context 提供，auditor/expert 各挂一行）：

```jsonc
change_bundle_read({
  "bundle": "17f21d4a..worktree",   // 省略 = 最近一次
  "path": "source/Sino_PEI/blocks/01_Cavity_A/100_Cycle_Selection_Cav_A.xml",
  "side": "after",                  // before | after | patch
  "offset": 0, "limit": 200
})
→ { manifest 片段（fingerprint/faces/change）, 文件片段, totalLines, nextOffset }
```

理由：

- 满足原则 3（expert 直接访问变更 XML），但**不**开放 `source/` 全量读权——上下文不会爆，政策可执行；
- 与"权能和规则必须成对"一致（D29 的教训）：没有这个工具时，expert 要么读不到、要么只能靠 leader 转述；
- 用 `patch` 模式时通常几 KB 就能看出改了什么，比读两个 155 KB 的 XML 省得多。

如果不想新增工具：退而求其次，policy 只允许 expert `read` `.dsh/changes/**`，并在 brief 里给绝对路径。缺点是无法阻止它读 `source/`。

---

## 7. 与现有实现的差距（审计结论）

| 需求 | 现状 | 改动 |
|---|---|---|
| diff 输出 old/new checksum、state | 只有 `revisions` 与 `files`；checksum/state 不进 payload | `projectDiff` 增加 `checksum`/`state`（复用 `readEvidenceAtRevision`） |
| diff 输出每块 before/after fingerprint | `BlockDiff.faces` 只有 `changed[]`（`diff.ts:1069`） | `faces` 扩展为 `{ changed[], before, after }` 或新增 `fingerprint` 字段（**仅展示，不写提交**） |
| diff 输出 elements[] | 只有 `blocks[]`（内部用，不面向模型） | 新增模型可见的 `elements[]`（key/name/category/group/path/change/fingerprint/faces） |
| 变更包导出 | 无 | `projectDiff` 增加 `bundle` 选项与写盘逻辑（`git show` + 工作树复制） |
| commit trailers 带 Prev | `commitTrailers` 只有新值（`commit.ts:95-102`） | 加 `Tia-Checksum-Prev` / `Tia-State-Prev`；**不做** `Tia-Changed` |
| commit 时取 old checksum | 无 | 读父提交 evidence（`git show HEAD~1:…/_evidence.json`），不跑全量 diff |
| 每提交记录 checksum | trailer 已有 `Tia-Checksum` | 增加 `Tia-Checksum-Prev`；**不引入 tag**（§3.2） |
| expert 读变更包 | 只有 `read/glob/grep`（政策禁止读 source） | 新增 `change_bundle_read`，挂 expert（可选 auditor） |
| `.dsh/` 忽略 | `.gitignore` 只忽略 `.dsh/local/` | 增加 `.dsh/` |
| leader 转接协议 | 无明文 | preset-leader persona 增加"预定义流程直接转接 / 否则提案" |
| auditor 不写 message | 现在要求它写（`cordis.patch.yml:483-492`） | 改为"只给清单+机器字段；message 由 leader 合成" |

**明确不做**（按原则 2 与 2026-10-28 决定）：

- `project_diff` 不输出 network 标题/注释/ST/parts 计数（这些属于 expert 从 XML 读）；
- 不在 diff 里做"unit 对齐"的复杂语义（那是 10-26 复盘里的 P0-2，本版不需要——diff 不再报 unit 级变更）；
- 不把块级 fingerprint 写进提交（2026-10-28 决定；`Tia-Changed` 不做）；
- 不把图谱刷新放进默认链路。

---

## 8. 已定 / 待确认

已定（2026-11-01）：

- **checksum 用 commit message 的 trailer 记录**（`Tia-Checksum` / `Tia-Checksum-Prev`），
  同一 checksum 可多次出现，检索用 `git log --grep='Tia-Checksum: …'` 或
  `--format='%(trailers:key=Tia-Checksum)'`；
- **不引入 tag**（ref 名唯一，无法表达重复 checksum，见 §3.2）；
- 历史 3 个提交**不补任何标记**。

已确认（2026-10-27）：

- expert 读变更包里的 XML（`change_bundle_read` 只读工具，不开放 `source/` 全量读权）；
- 变更包只保留最近一次。

待确认：

1. **旧图谱是否在 brief 里显式标注**：例如 `graph built at C0 01 C3 … (stale vs source 71 2D …)`。


---

## 9. 验收（回放 17f21d4a..a5f84d5d）

| # | 断言 |
|---|---|
| 1 | `checksum.from = C0 01 C3 13 58 AC 0E 50`，`checksum.to = 71 2D DC D7 F9 DF 81 90` |
| 2 | `elements` 恰好 1 条：`blocks|01_Cavity_A|100_Cycle_Selection_Cav_A`，`change=modified` |
| 3 | `fingerprint.before/after` 各有 Code/Interface/Comments/Properties，`faces = [Code, Interface, Comments]` |
| 4 | bundle 内 `before/` 与 `after/` 各一份 XML，`diff.patch` 行数与 `git diff` 一致 |
| 5 | 提交后 `git log --grep='Tia-Checksum: 71 2D DC D7'` 命中该提交；`--format='%(trailers:key=Tia-Checksum)'` 每提交一行；重复 checksum 时列出多行 |
| 6 | `git log --format='%(trailers:key=Tia-Checksum-Prev)'` 读到 C0…，`Tia-Checksum` 读到 71… |
| 7 | expert 只读 bundle，不读 `source/`，不刷新图谱；往返 ≤ 10 次 |
| 8 | 全程 0 条 `pwsh` 解析 XML |
