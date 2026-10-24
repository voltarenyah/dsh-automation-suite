# 路径规则：workspace 内的工程布局

> **状态：2026-10 按 [`decisions.md`](decisions.md) D22 重写，S2 补齐版本管理布局。**
> 本文原先定义的是 P0/P1 的 `projects/<id>/{work,source,export}` + `_dsh-eng/projects.json`
> 注册表；那条路线连同 4 个工具（`eng_status` / `eng_project` / `eng_scope` / `eng_version`）
> 已删除。现在的布局是 **`tia/` + `source/` + `.dsh/local/`**，模型面是
> `create_engineering_project` / `project_status` / `project_sync` 三个工具。
> 核心架构见 [`ARCHITECTURE.md`](ARCHITECTURE.md)，为什么这样定见 [`decisions.md`](decisions.md)
> D22 与 **D26**。

---

## 1. 目的与适用范围

| 问题 | 本文的回答 |
|---|---|
| 工程项目路径**包括哪些内容** | §2 的目录树 + §8 的清单 |
| workspace 里"放什么、怎么放" | §2 / §5 |
| 插件**能碰哪些路径** | §4 的越界校验（fail-closed） |
| 什么进 git、什么不进 | §6 |
| 与接口插件族的导出物怎么对接 | §7 |

**适用范围**：workspace 根 = 会话的工作目录（`exec.agent.session.header.cwd`），
也就是宿主 workspace 注册表里的那个目录。**本插件不定义 workspace 本身**，只定义它里面的布局。

---

## 2. 目录树

```
<workspace>/                                  ← = session cwd，宿主 registry 认领
│
├── tia/                                      ← **TIA 的工程**（二进制，整个目录不进 git）
│   └── <workspace 名>/                        ← 另存的目标目录；TIA 会**用它**命名工程
│       └── <workspace 名>.ap17                 ← 工程文件本身
│
├── source/                                   ← **重建的源文件树**（文本，进 git）
│   ├── _dsh-engineering-context.json         ← 本插件的索引：这棵树属于哪个工程、上次导出产出了什么（§8）
│   └── <device>/
│       ├── blocks/<用户组路径>/<块名>.xml
│       ├── types/<组>/<类型名>.xml
│       ├── tag_tables/<表名>.xml
│       ├── _evidence.json        ← **权威账本**：逐对象指纹 / 归一化哈希 / checksum / 墓碑（§2.1）
│       └── _manifest.json        ← **派生清单**：磁盘上有什么、多大、sha256、类型元数据（§2.2）
│
├── knowledge/                                ← **知识图谱库**（二进制；`*.db*` 不进 git，见 §6）
│   └── <device>/<device>_knowledge.db         ← 图谱插件从上面那棵树做的**全量重建**（D25 / 发行版 D20）
│
├── .dsh/local/                               ← **本机临时状态**（不进 git）
│   ├── lock.json                             ← workspace 锁（TTL 15 min）
│   └── stage/<id>/                           ← 一次同步的 STAGE：只放差异与两份文档，成功后删除
│
├── .gitignore                                ← 由 create_engineering_project 维护（只追加三条规则，§6）
└── .git/                                     ← 建议：workspace 根一个仓库
```

**为什么目录名是 <workspace 名>，而不是工程名**：**一个 workspace 只管一个工程**（使用者口径；
A5 的 session ↔ workspace 绑定），而 **TIA 会用目标目录名给工程命名** —— 真机实测：另存进
`tia/` 之后，工程就叫 `tia`，源工程名丢了。所以目录名取**workspace 的名字**（宿主 registry 的
title，没有就用目录名）：它确定、在打开任何工程之前就知道，于是磁盘上的工程名也确定
（`tia/<workspace 名>/<workspace 名>.ap17`），而不是由"我们恰好选了哪个目录"决定。

工程自身的名字仍然作为**身份**记在 `source/_dsh-engineering-context.json` 里，工具在写之前比对 ——
发现是**另一个工程**就拒绝（`source_belongs_to_another_project`），而不是让两棵树的 device 目录
（`S7-1500`、`PLC_1` 这类重名极常见）悄悄互相覆盖。身份按**记录的工程文件路径**判定（源工程与
工作区副本两条都记），不按名字 —— 因为名字会被 TIA 改写（见上）。

**为什么是两棵树**：`tia/` 里的东西是 TIA 的 —— 二进制、只能在 TIA 里改，进版本库只能得到
"变了/没变"（[`docs/vision.md`](../../../docs/vision.md) §3.3）；`source/` 里的是文本产物，
可 diff、可入库、可被工程知识图谱插件解析。把两者混在一起，就没有任何规则能回答"这个文件该不该提交"。
`knowledge/` 里的第三种东西是**派生的大二进制**：图谱插件从 `source/` 全量重建的 SQLite 库
（实测约 450 MB），既不是可读文本，也不是手工编辑的对象 —— 所以只忽略**数据库文件本身**
（`*.db` 及其 `-wal` / `-shm` / `-journal` 旁挂文件），目录本身留给
将来可能出现的文本产物（D25）。

### 2.1 `source/<device>/_evidence.json`：权威账本

**只有控制器的 `SyncScan` 写它**，本插件只负责提交、读取、展示。它回答"每个对象的哪一面变了"：

| 字段 | 含义 |
|---|---|
| `schemaVersion` / `hashAlgo` | 固定 `1` / `xml-norm-v1`；不含时间戳 |
| `safetyRecorded` | `true` 表示这次扫描记录过 F 块的 `SafetySignatureProvider` 签名；旧账本没有该字段，升级后的第一次同步会强制补扫一次 |
| `device` / `software` / `plcChecksum` | 这份账本对应的 PLC 与 `PlcChecksumProvider.Software` |
| `stateId` | 由对象 key + 指纹/哈希 + F 签名推出的稳定摘要（提交信息里的 `Tia-State`） |
| `objects.<key>` | `category` / `name` / `group` / `path`（相对 device 目录）/ `fingerprint`（块、UDT）/ `contentHash`（标签表）；F 块另有 `isSafetyBlock: true` 与 `safetySignature{type,value}` |
| `unexportable[]` | 存在但 TIA 导不出的对象；同步时**保留旧文件**，绝不因为导不出就删。F-OB（如 `FOB_SAFETY`）也在这里，F 签名是它唯一的变更证据 |
| `tombstones[]` | 真正消失的对象；同步时据此删除对应的旧 XML |

**相等性只来自这里**：checksum 相同且账本可用 → 快路径 `unchanged`；checksum 不同 → 慢路径逐对象
比指纹/哈希，F 块再比 `safetySignature`（value `0` = 尚无有效签名），只导出差异。路径是**相对 device 目录**的，
所以整棵树可以跨机器 diff。旧账本缺 `safetyRecorded` 时不做"F 块全都变了"的误判：那一次只比指纹。

### 2.2 `source/<device>/_manifest.json`：派生清单

同一次 `SyncScan` 调用生成/增量维护，**不参与相等性判断**，只描述磁盘上的文件：

```jsonc
{
  "schemaVersion": 1,
  "protocol": "…",
  "generatedBy": "TiaOpennessV17Min.Controller",
  "device": "Sino_PEI",
  "software": "Sino_PEI",
  "categories": ["blocks", "types", "tag_tables"],
  "failureCount": 0,
  "blocks": [
    {
      "category": "block", "name": "FB_Motor", "group": "010_Cell",
      "file": "blocks/010_Cell/FB_Motor.xml",   // 相对路径；无 outputDir、无生成时间
      "bytes": 12345,
      "sha256": "…",
      "verified": true,
      "simaticType": "FB",
      "declaredName": "FB_Motor",
      "declaredNumber": "34",
      "programmingLanguage": "SCL"
    }
  ]
}
```

**为什么不用它的 `sha256` 当变更键**：TIA 导出的 XML 自带 `<DocumentInfo><Created>`，重新导出就会变
（`MANIFEST-GAP-ANALYSIS.md` §3）。清单缺失/损坏只会让下一次同步多做一次全量导出，
**不会被当成"没有变化"**。

---

## 3. 三条硬规则

1. **一切写入路径由插件解析，模型不给目标路径。**
   `create_engineering_project` 的**目标**目录由 workspace 根 + 配置的目录名推出（§5），
   参数里没有它们。唯一例外是 `source_project`：**要打开哪个工程**天生是一个磁盘路径
   （接口插件的 `openProject` 只接受绝对路径），而它只在 TIA 没有打开工程时用得上；
   不知道路径时**向用户要**，不要自己去磁盘上找 —— 这条写在工具描述里。

2. **目标目录在写之前必须过 `realpath` 包含性校验。**
   候选路径不存在时，对**最近的已存在祖先**归一后再接回剩余段 —— 不允许"因为不存在所以跳过校验"。

3. **不擅自采用、不删除。**
   目标目录已存在时：另存交给 TIA 判断（它拒绝就把 TIA 的理由原样报出来），源文件树已存在时默认
   **跳过并计数**，要覆盖必须显式 `overwrite: true`。`create_engineering_project` **永不删除**任何文件。
   唯一的删除发生在 `project_sync`：账本里出现墓碑（对象真的从 TIA 里消失）时，删除它在 SOURCE
   里的旧 XML —— 而且只删 `source/<device>/` 之内、只删账本记得的路径。
   TIA 导不出的对象（`unexportable`）**不删**旧文件：它仍然存在于工程里，只是这次导不出来。

4. **STAGE 只是暂存，不是第二份状态。**
   `SyncScan` 把差异写进 `<workspace>/.dsh/local/stage/<id>/`，`project_sync` 提升完（或失败）后
   一律清掉；`.dsh/local/` 整体不进 git。设备目录才是长期状态，STAGE 里没有"只存在于 STAGE 的版本"。

---

## 4. 路径解析与越界校验（fail-closed）

### 4.1 校验算法

```
assertInsideWith(config, workspaceRoot, candidate):
    a = realpath.native(workspaceRoot)        # 归一：消掉 ..、解析符号链接、取盘上真实大小写
    b = realpath.native(candidate)            # 候选不存在时：对其最近的已存在祖先归一，再接回剩余段
    rel = path.relative(a, b)
    if rel === ''            → ok（就是根自身）
    if path.isAbsolute(rel)  → 越界
    if rel === '..' || rel.startsWith('..' + path.sep) → 越界
    else → ok
```

**两条实现要求**：

- **用 `realpath`，不用字符串前缀比较。** Windows 上路径大小写不敏感，`C:\a\..\b` 与符号链接/junction
  都能绕过朴素的 `startsWith`。本仓已有链接事故记录
  （`packages/dsh-tia-openness-v17-min/docs/ECOSYSTEM-COMPAT.md`），这里不重犯。
- **归一失败**（权限、设备路径异常）→ 直接拒绝，不降级。

### 4.2 拒绝语义

| 情形 | 错误码 | 备注 |
|---|---|---|
| 目标在 workspace 之外 | `path_outside_workspace` | 结果里给出 workspace 根与目标路径 |
| 缺 `session.header.cwd` | `scope_unavailable` | 不猜 cwd |
| 这个组合没挂接口插件 | `tia_access_unavailable` | 本插件从不自己连 TIA |
| 服务调用本身失败（控制器缺失/超时/协议） | `tia_unreachable` | 操作级失败是数据，传输级失败才是这个 |
| 控制器没在跑 | `tia_controller_not_running` | 状态，不是异常；**一个操作都不发** |
| 控制器在跑但 TIA 没开工程 | `tia_project_not_open` | 同上 |
| TIA 没报出可用的项目名 | `project_name_unavailable` | 不猜目录名 |

---

## 5. 命名规则

| 项 | 规则 |
|---|---|
| `<项目名>` 目录 | TIA 的项目名 → `folderName()`：非法字符（`\ / : * ? " < > \|` 与控制字符）→ `_`；去掉首尾的点与空格（Windows 会静默去掉，导致名字与目录不一致）；Windows 保留设备名（`nul`/`con`/`com1`…）前缀 `_`；`project` 兜底；上限 120 字符 |
| 大小写与语言 | **原样保留**（`电机启停控制` 就是 `电机启停控制`）。不做 slug —— 目录名要能对上 TIA 里的名字 |
| 项目名缺失时 | 退化为 `projectPath` 的文件名（去扩展名）；两者都没有则 `project_name_unavailable`，**不猜** |
| 设备目录名 | 由接口插件的 `rebuildSource` 定死（同一套安全化 + 撞名追加 `~2`），见 D21 |
| 导出物文件名 | 沿用接口插件族的既有规则（对象名 + `.xml`，撞名 `~2`），本文不重复定义 |

---

## 6. git 边界

| 进 git | 不进 git | 为什么 |
|---|---|---|
| `source/**`（源文件树 + `_evidence.json` + `_manifest.json`） | **`tia/**`（整个目录）** | 工程是二进制，只在 TIA 里改；文本产物与账本才是可读、可 diff、可审阅的东西 |
| `<workspace>/.gitignore` | **`knowledge/**/*.db*`（图谱库及其 SQLite 旁挂文件）** | 图谱库是 `source/` 的**全量重建派生品**、二进制且很大，重新导出即可再生 |
| 每次 `project_sync` 的**一次提交**（路径限定 `source/<device>`） | **`.dsh/local/**`（锁 + STAGE）** | 临时状态：锁是进程间互斥，STAGE 是差异暂存；都不该出现在历史里 |
| | `**/*.ap17` | 工程文件本身 |

**`.gitignore` 由本插件维护，但只追加**（`create_engineering_project`，缺文件时创建并带注释头）：

```gitignore
# Written by @voltarenyah/dsh-engineering-context (create_engineering_project).
# The TIA project directory holds the projects this workspace saved into it: binary, and
# edited in TIA Portal rather than here, so it is not versioned. The rebuilt source tree
# beside it is the text artifact that belongs in version control.
# knowledge/**/*.db* holds the knowledge databases the engineering-graph plugin
# rebuilds from that source tree: binary, large and derived, so not versioned either
# (the trailing * also covers SQLite -wal / -shm / -journal side files).
# .dsh/local/ holds this plugin's lock and STAGE directory: local runtime state that a
# sync writes and deletes, never a versioned artifact.
tia/
knowledge/**/*.db*
.dsh/local/
```

六条自我约束：

- **已有该行时不动文件**；文件已存在但没有该行时**只追加缺的那一行**，绝不重写用户的内容；
  `tia/`、`/tia/`、`tia` 三种写法都算"已有"；`knowledge/**/*.db*` 同样按带前导斜杠的写法认定，
  窄规则 `knowledge/**/*.db`（没有尾随 `*`）**不算已有**；`.dsh/local/` 同理；
- 规则在**另存成功之后、导出与建图之前**写入 —— 目录里一有工程、一有库，ignore 就必须已经生效，
  否则下一次 `git add -A` 会把二进制工程、几百 MB 的库或本机锁带进仓库；
- 只忽略**数据库文件**，不忽略整个 `knowledge/`：那是图谱插件的地盘，将来它在那里写出的**文本**产物
  与 `source/` 有同样的入库理由；
- **`project_sync` 会提交，但只提交一个 device 目录**：`git add -- source/<device>` +
  `git commit -- source/<device>` 使用同一个 pathspec，所以 workspace 里其他被暂存的内容不会搭车；
- **从不 `init`、从不 `push`、从不 `reset`/`--force`/改历史**：仓库不存在时
  `repository_not_found` 并让用户自己 `git init`（D13）。提交信息带四个 trailer：
  `Tia-Op: sync` / `Tia-Checksum` / `Tia-State` / `Tia-Manifest: rebuilt|updated`，
  所以"这次提交对应哪一份 TIA 状态"永远可查；
- **`project_status` 只读 git**：`rev-parse` + `status --porcelain -- <device>`，用于回答
  "还有没有未提交的差异"，不写任何东西。

---

## 7. 与两个兄弟插件的对接

**不改兄弟插件的既有契约**，只调用它们的服务、读它们返回的事实。

### 7.1 接口插件族（缝 A，`engineeringAccess`）

| 接口插件族的产出 | 本插件怎么用 |
|---|---|
| `rebuildSource(root)` 的返回（`devices` / `failures` / `missingDevices`） | `create_engineering_project` 用它做第一次全量导出；结果里逐设备给 exported/failed，`devices[].directory` 是后续所有操作的输入 |
| `readPlcChecksum({deviceName})` | `PlcChecksumProvider.Software`（V17 的属性名不是 `Checksum`）；空串 → `needs_compile`，不当成失败 |
| `syncScan({sourceRoot, stageDir, evidencePath, manifestPath, deviceName})` | `project_sync` 的唯一取证调用：控制器自己遍历/比对/只导出差异，并在**同一次调用**里写好 stage 里的 `_evidence.json` 与 `_manifest.json`。`sourceRoot` 传 **device 目录**（清单里的 `file` 相对它） |
| 每个 device 一份 `_manifest.json` | **读返回里的路径**，不要自己拼 —— 路径是运行时返回的事实，不是两边各自维护的约定 |
| 被 TIA 拒绝的对象 | 逐条进结果与 warning，不静默丢 |

`source/<device>/` 以下的一切布局由接口插件**定死在代码里**（D21 / 该包 D24）：
本插件只决定 root 是哪个目录、STAGE 在哪，不参与它下面的结构。

### 7.2 图谱插件（缝 B，`knowledgeGraph`）

| 图谱插件的产出 | 本插件怎么用 |
|---|---|
| `status()`（`available` / `reason` / `enginePath` / `databaseConvention`） | `available:false` 时**只**报"图谱未建成"，一个 `ingestDevice` 都不发 |
| `ingestDevice(deviceDir)` 的规范信封（`ok` / `summary` / `data` / `error` / `durationMs`） | 逐设备调用，`deviceDir` 直接用族 1 返回的 `devices[].directory`；**不传 `dbPath`** |
| `data.dbPath` | 结果里如实带回实际落点（约定见 §2），本插件不自己拼这个路径 |
| `data.warnings[]`（含清单里的 `failures[]`，即 TIA 拒绝导出的对象） | 转成工作流诊断（warning），有上限，全量留在 `data.knowledge.devices[].warnings` |
| 抛出的传输错误（引擎 exe 不在、超时、进程中途退出） | 降级为"图谱未建成"，**不让工作流失败**；只有调用被取消时才向上抛 |
| 它是**全量重建**、没有增量 | 每次真实运行都调一次（包括"所有文件都已存在"的刷新路径）—— 这是唯一的刷新方式 |

`knowledge/<device>/` 以下的一切布局由图谱插件定死；本插件只把 `deviceDir` 递过去，
并维护 §6 里那一行 ignore。

---

## 8. 清单：这些路径分别是谁写的

| 路径 | 谁写 | 进 git | 可删？ |
|---|---|---|---|
| `tia/<workspace 名>/**` | **TIA**（经 `engineeringAccess.saveProjectAs`） | ❌ | 可以（TIA 里的那份还在） |
| `source/<device>/` 下块、类型、标签表的 XML | 接口插件（`rebuildSource` 首次、`syncScan` 增量） | ✅ | 可以（重新同步即可，慢） |
| `source/<device>/_evidence.json` | 接口插件的 `SyncScan`（本插件只提交） | ✅ | 可以，但下一次同步会退化成全量导出 |
| `source/<device>/_manifest.json` | 同一次 `SyncScan`（增量合并） | ✅ | 可以（同上：强制一次全量导出，不会误删文件） |
| `knowledge/<device>/<device>_knowledge.db`（及其 `-wal` / `-shm` / `-journal` 旁挂文件） | 图谱插件（经 `knowledgeGraph.ingestDevice`，本插件只触发） | ❌（`*.db*`） | 可以（全量重建即可，大工程分钟级） |
| `<workspace>/.dsh/local/lock.json` | `project_sync` / `project_status` 读、`project_sync` 写（TTL 15 min） | ❌（`.dsh/local/`） | 可以（进程真的不在了就删） |
| `<workspace>/.dsh/local/stage/<id>/` | 接口插件的 `SyncScan` 写，`project_sync` 提升后删除 | ❌（`.dsh/local/`） | 可以（只是暂存） |
| `<workspace>/.gitignore` | `create_engineering_project`（只追加三行） | ✅ | 可以（下次调用会重建缺的行） |
| `_dsh-eng/**`（P3 台账） | **尚未实现**；路径待定 | — | — |

> **删掉注册表之后**：workspace 里"有哪些工程"不再由任何文件登记，而是**目录布局本身**就是记录
> （`tia/` 里有什么、`source/` 里有什么）。这是 D22 的刻意取舍：宁可少一层记账，也不要一层没人读的状态。

---

## 9. 可调参数（配置面）

| 配置 | 默认 | 含义 |
|---|---|---|
| `tiaDirName` | `tia` | 工程本体目录名（必须是单个安全路径段，否则回退默认） |
| `sourceDirName` | `source` | 源文件树目录名（同上） |
| `stateDirName` | `.dsh` | 本机临时状态目录名；锁与 STAGE 落在 `<stateDirName>/local/`（同上） |
| `requireWorkspace` | `true` | `true` 时越界一律拒绝；`false` 仅用于测试 |

---

## 10. 已废止（历史，保留以免误读旧文档）

| 废止项 | 原状 | 现状 |
|---|---|---|
| `projects/<id>/{work,source,export}` | P0/P1 的布局 | 删除，改为 `tia/` + `source/`（D22） |
| `_dsh-eng/projects.json` 注册表 + `current` 指针 | `eng_project` / `eng_scope` 读写 | 删除（D22） |
| `eng_project register` 的"不擅自采用既有目录"规则 | 由注册表实现 | 由 §3 规则 3 直接实现（目标已存在时 TIA 判断 / 跳过并计数） |
| `init_vcs`（`register` 时初始化仓库） | PATH-RULES §6.2 的目标态 | **从未实现，且不再需要**：`project_sync` 只在已有仓库里提交，永不 `git init` |
| `eng_version` 的"导出物 + 状态入库" | P1 | 删除（D22）；版本管理改为 `project_sync` 的"TIA → SOURCE → 一次提交"（D26） |
