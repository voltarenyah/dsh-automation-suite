# 路径规则：workspace 内的工程布局

> **状态：设计定稿（答复 [`docs/open-questions.md`](../../../docs/open-questions.md) 的 B7）。**
> 本文是工程上下文插件的**交付物**之一：它规定"workspace 里放什么、怎么放"，
> 以及"哪些路径是插件可以碰的"。核心架构见 [`ARCHITECTURE.md`](ARCHITECTURE.md)，
> 为什么这样定见 [`decisions.md`](decisions.md)。
>
> 本文里的路径都是**设计值**，实现时可以调；调了必须同步本文与该包 `decisions.md`。

---

## 1. 目的与适用范围

| 问题 | 本文的回答 |
|---|---|
| 工程项目路径**包括哪些内容** | §2 的目录树 + §8 的字段级定义 |
| workspace 里"放什么、怎么放" | §2 / §4 |
| 插件**能碰哪些路径** | §4 的越界校验（fail-closed） |
| 什么进 git、什么不进 | §6 |
| 与接口插件族的导出物怎么对接 | §7 |

**适用范围**：workspace 根 = 会话的工作目录（`exec.agent.session.header.cwd`），
也就是宿主 workspace 注册表里的那个目录（判定规则见 [`ARCHITECTURE.md`](ARCHITECTURE.md) §2.1）。
**本插件不定义 workspace 本身**，只定义它里面的布局。

---

## 2. 目录树

```
<workspace>/                                  ← = session cwd，宿主 registry 认领
│
├── projects/                                 ← 工程内容（每个工程一棵子树）
│   └── <project-id>/
│       ├── source/                           ← 「另存」来的源项目副本（只读）
│       │   └── <name>.ap17
│       ├── work/                             ← 工作副本：**唯一会被修改的** .ap17
│       │   └── <name>.ap17
│       └── export/                           ← 导出物（派生视图，供工程知识图谱插件解析）
│           ├── _tia-openness-manifest.json   ← 接口插件族产出的清单（既有契约，不改）
│           ├── <用户组路径>/<块名>.xml        ← blocks 直接放在 export/ 下（接口插件族的既有布局）
│           ├── types/<组>/<类型名>.xml
│           └── tag_tables/<表名>.xml
│
├── _dsh-eng/                                 ← **插件状态**（可携带、可进 git）
│   ├── projects.json                         ← 工程注册表（含**唯一**的"当前工程"指针）
│   └── <project-id>/                         ← 该工程的状态（P2/P3：基线、变更集、台账）
│       ├── fingerprints.json                 ← 指纹基线
│       ├── changes-<ts>.json                 ← 变更集工件
│       └── change-context.json               ← 工程变更台账
│
├── .dsh/skills/                              ← 项目级 skill（可选，A12）
└── .git/                                     ← 建议：workspace 根一个仓库（§6）
```

**为什么工程内容与插件状态分两棵树**：`projects/` 是"用户的工程"（换工具也该留着），
`_dsh-eng/` 是"本插件的状态"（删了会丢基线与台账，但不丢工程）。
混在一起会让"哪些文件是工程的、哪些是我的"无法回答。

---

## 3. 三条硬规则

1. **一切路径由插件解析，模型只给"名字"。**
   模型给 `project` / `branch` / `version` / 对象名 —— 不给绝对路径。
   解析结果必须是 `<workspace>` 的后代（§4）。

2. **源 `.ap17` 一旦「另存」完成就不再被读写。**
   `source/` 是溯源信息，不是工作对象；`work/` 才是。
   这样"新会话只能访问自己 workspace 下的工程"是**结构性**成立的，而不是靠提醒。

3. **不擅自采用既有目录。**
   `projects/` 下已经存在、但注册表里没有的目录，插件**不得**自动登记、不得改写、不得删除。
   采用必须走显式的 `eng_project register`。

---

## 4. 路径解析与越界校验（fail-closed）

### 4.1 校验算法

```
assertInside(workspaceRoot, candidate):
    a = realpath.native(workspaceRoot)        # 归一：消掉 ..、解析符号链接、取盘上真实大小写
    b = realpath.native(candidate)            # 候选不存在时：对其最近的已存在祖先归一，再接回剩余段
    rel = path.relative(a, b)
    if rel === ''            → ok（就是根自身）
    if path.isAbsolute(rel)  → 越界
    if rel === '..' || rel.startsWith('..' + path.sep) → 越界
    else → ok
```

**三条实现要求**：

- **用 `realpath`，不用字符串前缀比较。** Windows 上路径**大小写不敏感**，且 `C:\a\..\b`
  与符号链接/junction 都能绕过朴素的 `startsWith`。本仓已有链接事故记录
  （`packages/dsh-tia-openness-v17-min/docs/ECOSYSTEM-COMPAT.md`），这里不重犯。
- **候选路径不存在时也要校验**（创建场景）：对"最近的已存在祖先"归一后再接回剩余段，
  不允许"因为不存在所以跳过校验"。
- **归一失败**（权限、设备路径、`\\?\` 之外的异常）→ 直接拒绝，不降级。

### 4.2 拒绝语义

| 情形 | 错误码 | 备注 |
|---|---|---|
| 目标在 workspace 之外 | `path_outside_workspace` | 结果里给出 workspace 根与目标路径（便于用户判断是不是选错了 workspace） |
| 缺 `session.header.cwd` | `scope_unavailable` | 不猜 cwd |
| 注册表不存在 | `project_not_registered` | 只允许 `eng_project register` |
| 工程 id 不存在 | `project_not_found` | 附可用 id 列表 |

---

## 5. 命名与冲突规则

| 项 | 规则 |
|---|---|
| `project-id` | 由 title 生成的 slug（小写、非字母数字→`-`、折叠连续 `-`）；**一旦生成不再变**（它是路径的一部分） |
| slug 冲突 | 追加 `-2`、`-3`…（不静默覆盖） |
| `<name>.ap17` | 保留源项目的文件名；同名不同工程由 `<project-id>` 目录区分 |
| 导出物文件名 | **沿用接口插件族的既有规则**（文件名 = 对象名 + `.xml`，非法字符替换为 `_`，撞名写 `<名>~2.xml` 并发 warning）—— 本文不重复定义，见 `packages/dsh-tia-openness-v17-min/docs/OUTPUT-CONTRACT.md` §2 |
| 时间戳后缀 `<ts>` | ISO-8601 的紧凑形式 `2026-10-14T09-12Z`（文件名安全、可排序、无冒号） |
| 已存在的目录/文件 | 默认**不覆盖**；需要覆盖时由调用方显式传 `overwrite: true` |

---

## 6. git 收录边界

### 6.1 进 / 不进

| 进 git | 不进 git | 为什么 |
|---|---|---|
| `projects/<id>/export/**`（导出物） | **`*.ap17`（源与工作副本）** | 二进制工程文件进 VCS 只能得到"变了/没变"（[`docs/vision.md`](../../../docs/vision.md) §3.3）；它在 TIA 里改，不进 git |
| `_dsh-eng/**`（基线、变更集、台账） | `projects/<id>/source/**` | `source/` 是溯源副本，重复且无版本意义 |
| `projects/<id>/export/_tia-openness-manifest.json` | TIA 的临时/锁文件 | — |

**为什么基线与导出物必须在同一个仓库里**：基线描述的是"导出物在某版本时长什么样"。
两者分开版本化，"这份基线对应哪一版导出物"就无法回答，而**失效可感知**正是本插件的验收口径
（[`ARCHITECTURE.md`](ARCHITECTURE.md) §10）。

### 6.2 仓库位置与既有仓库

- 仓库根 = 从 workspace 根执行 `git rev-parse --show-toplevel` 得到的目录；
  `eng_status` 必须报告它。
- **仓库根在 workspace 之外**（workspace 落在用户的某个大仓库里）时：仍然工作，
  但结果里必须**警告**——此时本插件的提交会与无关内容共享历史。
- **workspace 不是仓库**时：**不自动 `git init`**。需要显式 `eng_project register` 时传
  `init_vcs: true`（默认 `false`）才初始化。理由：在用户的目录里凭空建仓库是难以察觉的副作用。
- **不使用 `--force`、不改写历史、不 push。** 内部 git 只做本地操作
  （`commit` / `log` / `show` / `diff` / `materialize`）。

### 6.3 建议的 `.gitignore`（由 `register` 在缺失时提出，需确认）

```gitignore
# 二进制工程文件：在 TIA 里改，不进 git
**/*.ap17
**/*.ap17.bak
projects/*/source/

# TIA 临时/锁文件
**/~*.tmp
```

---

## 7. 与接口插件族导出物布局的对接

**不改接口插件族的既有契约**，只消费它：

| 接口插件族的产出 | 本插件怎么用 |
|---|---|
| `export/_tia-openness-manifest.json` | 读 `counts` / `blocks[]` / `failures[]`，用于"导出物是否完整、哪些对象被 TIA 拒绝" |
| 清单里的 `sha256` | **只作完整性审计**（同一份 manifest 内防篡改）。**不作变更键**（它含 `<DocumentInfo><Created>`，每次导出都变，见 `MANIFEST-GAP-ANALYSIS.md` §3） |
| 清单里的 `name` / `group` / `simaticType` / `declaredNumber` / `programmingLanguage` | 用作**身份键的组成部分**（`category + group + name`，见 [`ARCHITECTURE.md`](ARCHITECTURE.md) §5.2） |
| 清单独缺的 `id` | 身份键的目标态；缺它时只能用 §5.2 的降级路径并在结果里标记 `identity: "by-name"` |
| 目录层级 = 用户组层级 | 直接复用为 `export/` 下的布局，**不再自定义一层** |

**`eng_export` 的写入范围**：只能写 `projects/<id>/export/` 之下；
导出目标在别处（例如用户直接传到 U 盘）需要显式覆盖，且必须通过 §4 的校验。

---

## 8. 字段级定义（B7 要求的"到哪一层"）

| 层 | 路径模板 | 谁写 | 进 git | 可删？ |
|---|---|---|---|---|
| **项目文件（源）** | `projects/<id>/source/<name>.ap17` | `eng_project adopt`（一次） | ❌ | 可以（丢溯源，不影响工作） |
| **工作副本** | `projects/<id>/work/<name>.ap17` | `eng_project adopt`；之后由 **TIA** 改 | ❌ | **不可以**（丢了要重新 adopt） |
| **导出物** | `projects/<id>/export/**` | 接口插件族经 `eng_export` 触发 | ✅ | 可以（可由 `.ap17` 重建，慢） |
| **基线** | `_dsh-eng/<id>/fingerprints.json` | `eng_changes`（`update_baseline`） | ✅ | 可以，但会丢"自上次以来"的能力 |
| **变更集** | `_dsh-eng/<id>/changes-<ts>.json` | `eng_changes` | ✅ | 可以 |
| **变更台账** | `_dsh-eng/<id>/change-context.json` | `eng_context` | ✅ | **不可以**（人工录入，无法重建） |
| **工程注册表** | `_dsh-eng/projects.json` | `eng_project` | ✅ | **不可以**（丢了要重新登记） |
| **项目级 skill** | `.dsh/skills/<name>/SKILL.md` | 用户 / agent（经确认） | ✅ | 可以 |

> **P0 实际会创建/写入的只有两项**：`_dsh-eng/projects.json`（register/forget/scope）与
> `projects/<id>/work/<name>.ap17`（adopt）。其余各行是 P1–P3 的目标态。
> **没有"作用域指针"文件**：`current` 就在注册表里（`decisions.md` P0-5 —— 两个指针会互相矛盾）。
>
> 另：`eng_project forget` **只**改注册表，不删任何文件；删文件这一动作本插件永远不做。

---

## 9. 可调参数（配置面）

**P0 已实现这三个**（`src/config.ts`，与 `package.json` 的 `Config` schema 一致）：

| 配置 | 默认 | 含义 |
|---|---|---|
| `projectsDirName` | `projects` | 工程内容目录名（必须是单个安全路径段） |
| `stateDirName` | `_dsh-eng` | 插件状态目录名（同上） |
| `requireWorkspace` | `true` | `true` 时越界一律拒绝；`false` 仅用于测试 |

**以下为后续期次的目标态，P0 还没有这些字段**：

| 配置 | 默认 | 含义 |
|---|---|---|
| `skillsDirName` | `.dsh/skills` | 项目级 skill 目录（P3 / A12） |
| `initVcs` | `false` | `register` 是否允许初始化仓库（§6.2，P1） |
| `adoptSourcePolicy` | `copy` | P0 只有 `copy`（字节复制）；`move` 未实现 |

---

## 10. 待确认（留给人的判断，不阻塞 P0）

| # | 事项 | 当前取值 | 备注 |
|---|---|---|---|
| 1 | 一个 workspace 多个工程时，`.git` 在 workspace 根还是每工程一个 | **workspace 根一个** | 理由见 §6.1（基线必须与导出物同版本）；若你更想要每工程独立历史/远端，可改，代价是"跨工程的同一次整理"不再是一次提交 |
| 2 | `_dsh-eng/` 目录名 | `_dsh-eng` | 下划线开头便于排序在 `projects/` 之前；可改 |
| 3 | `source/` 是否保留 | **保留**（`copy`） | 换成 `move` 可省一份 `.ap17` 的空间，但那是源项目的唯一副本，风险更高 |
