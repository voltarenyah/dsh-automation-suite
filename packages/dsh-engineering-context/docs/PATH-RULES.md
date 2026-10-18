# 路径规则：workspace 内的工程布局

> **状态：2026-10 按 [`decisions.md`](decisions.md) D22 重写。**
> 本文原先定义的是 P0/P1 的 `projects/<id>/{work,source,export}` + `_dsh-eng/projects.json`
> 注册表；那条路线连同 4 个工具（`eng_status` / `eng_project` / `eng_scope` / `eng_version`）
> 已删除。现在的布局是 **`tia/` + `source/`**，模型面只有 `create_engineering_project` 一个工具。
> 核心架构见 [`ARCHITECTURE.md`](ARCHITECTURE.md)，为什么这样定见 [`decisions.md`](decisions.md) D22。

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
│       ├── blocks/_tia-openness-manifest.json
│       ├── blocks/<用户组路径>/<块名>.xml
│       ├── types/<组>/<类型名>.xml
│       ├── tag_tables/<表名>.xml
│       └── _tia-openness-manifest.json        ← 该 device 的清单：**一次导出覆盖三类**
│
├── knowledge/                                ← **知识图谱库**（二进制；`*.db*` 不进 git，见 §6）
│   └── <device>/<device>_knowledge.db         ← 图谱插件从上面那棵树做的**全量重建**（D25 / 发行版 D20）
│
├── .gitignore                                ← 由 create_engineering_project 维护（只追加 `tia/` 与 `knowledge/**/*.db*`）
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
   **跳过并计数**，要覆盖必须显式 `overwrite: true`。本插件**永不删除**任何文件。

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
| `source/**`（重建的源文件树） | **`tia/**`（整个目录）** | 工程是二进制，只在 TIA 里改；文本产物才是可读、可 diff 的东西 |
| `<workspace>/.gitignore` | **`knowledge/**/*.db*`（图谱库及其 SQLite 旁挂文件）** | 图谱库是 `source/` 的**全量重建派生品**、二进制且很大，重新导出即可再生；`-wal` / `-shm` / `-journal` 是它同一批本地文件 |
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
tia/
knowledge/**/*.db*
```

四条自我约束：

- **已有该行时不动文件**；文件已存在但没有该行时**只追加缺的那一行**（另一行已存在就不再写它），
  绝不重写用户的内容；`tia/`、`/tia/`、`tia` 三种写法都算"已有"；
  `knowledge/**/*.db*` 同样按带前导斜杠的写法认定，而窄规则 `knowledge/**/*.db`（没有尾随 `*`）
  **不算已有** —— 它挡不住 SQLite 的旁挂文件，所以宽的那一行会被补上，旧的窄行留在原处；
- 规则在**另存成功之后、导出与建图之前**写入 —— 目录里一有工程、一有库，ignore 就必须已经生效，
  否则下一次 `git add -A` 会把二进制工程或几百 MB 的库带进仓库；
- **本插件完全不碰 git**：不 `init`、不 `commit`、不 `force`、不 `push`（D13 的"从不自动 `init`"由此
  变成"从不碰 git"）。版本化交给用户自己的 git；
- 只忽略**数据库文件**（`knowledge/**/*.db*`：`.db` 加 SQLite 的 `-wal` / `-shm` / `-journal`
  旁挂文件），不忽略整个 `knowledge/`：那是图谱插件的地盘，将来它在那里写出的**文本**产物
  与 `source/` 有同样的入库理由。

---

## 7. 与两个兄弟插件的对接

**不改兄弟插件的既有契约**，只调用它们的服务、读它们返回的事实。

### 7.1 接口插件族（缝 A，`engineeringAccess`）

| 接口插件族的产出 | 本插件怎么用 |
|---|---|
| `rebuildSource(root)` 的返回（`devices` / `failures` / `missingDevices`） | 结果里逐设备给 exported/failed、逐条列被 TIA 拒绝的对象；`devices[].directory` 同时是下面缝 B 的输入 |
| 每个 device 一份 `_tia-openness-manifest.json` | **读返回里的路径**，不要自己拼 —— 路径是运行时返回的事实，不是两边各自维护的约定 |
| 被 TIA 拒绝的对象 | 逐条进结果与 warning，不静默丢 |

`source/<device>/` 以下的一切布局由接口插件的 `rebuildSource` **定死在代码里**（D21）：
本插件只决定 root 是哪个目录，不参与它下面的结构。

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
| `source/<device>/**` | 接口插件（经 `rebuildSource`） | ✅ | 可以（重新导出即可，慢） |
| `knowledge/<device>/<device>_knowledge.db`（及其 `-wal` / `-shm` / `-journal` 旁挂文件） | 图谱插件（经 `knowledgeGraph.ingestDevice`，本插件只触发） | ❌（`*.db*`） | 可以（全量重建即可，大工程分钟级） |
| `<workspace>/.gitignore` | `create_engineering_project`（只追加两行） | ✅ | 可以（下次调用会重建缺的行） |
| `_dsh-eng/**`（指纹基线、变更集、台账） | **P2/P3，尚未实现**；路径待定 | — | — |

> **删掉注册表之后**：workspace 里"有哪些工程"不再由任何文件登记，而是**目录布局本身**就是记录
> （`tia/` 里有什么、`source/` 里有什么）。这是 D22 的刻意取舍：宁可少一层记账，也不要一层没人读的状态。

---

## 9. 可调参数（配置面）

| 配置 | 默认 | 含义 |
|---|---|---|
| `tiaDirName` | `tia` | 工程本体目录名（必须是单个安全路径段，否则回退默认） |
| `sourceDirName` | `source` | 源文件树目录名（同上） |
| `requireWorkspace` | `true` | `true` 时越界一律拒绝；`false` 仅用于测试 |

---

## 10. 已废止（历史，保留以免误读旧文档）

| 废止项 | 原状 | 现状 |
|---|---|---|
| `projects/<id>/{work,source,export}` | P0/P1 的布局 | 删除，改为 `tia/` + `source/`（D22） |
| `_dsh-eng/projects.json` 注册表 + `current` 指针 | `eng_project` / `eng_scope` 读写 | 删除（D22） |
| `eng_project register` 的"不擅自采用既有目录"规则 | 由注册表实现 | 由 §3 规则 3 直接实现（目标已存在时 TIA 判断 / 跳过并计数） |
| `init_vcs`（`register` 时初始化仓库） | PATH-RULES §6.2 的目标态 | **从未实现，且不再需要**：本插件不再碰 git |
| `eng_version` 的"导出物 + 状态入库" | P1 | 删除，交给用户自己的 git（D22） |
