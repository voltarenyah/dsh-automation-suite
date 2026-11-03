/**
 * The guide's content: categories, entries and the prompt recipes themselves.
 *
 * This module is **data, not render**: the host serves it as JSON and the page
 * (`page/app.js`) turns it into cards. That split is deliberate — the text is
 * the part that will change most, and it must not need a client rebuild.
 *
 * Two invariants the tests enforce:
 *
 *  - every `tools` name exists in the suite's real tool surface (`TOOL_CATALOG`),
 *    so a card cannot advertise a capability that is not wired;
 *  - every localized string exists in both languages, because the page has a
 *    language toggle and a missing translation must fail the build, not fall
 *    back to an empty card.
 *
 * The `tools` field also carries the *visibility* nuance: the default `leader`
 * preset does not hold every tool named here (e.g. `knowledge_search` and
 * `knowledge_variable_usage` live with the `expert` subagent), which is why some
 * entries say so in `outcome`/`note` instead of implying the main agent runs
 * them directly.
 *
 * @module dsh-ui-prompt-guide/guide
 */

/** One string in both languages the app ships. */
export interface Localized {
  zh: string
  en: string
}

/** A section of the guide. */
export interface PromptCategory {
  /** Stable id used by entries and by the page's nav. */
  id: string
  /** Sort key; lower first. */
  order: number
  title: Localized
  summary: Localized
}

/** One card: when to use it, what to type, what happens. */
export interface PromptEntry {
  /** Stable id, unique across the document. */
  id: string
  /** Category id this entry belongs to. */
  category: string
  /** Sort key inside the category; lower first. */
  order: number
  title: Localized
  when: Localized
  prompt: Localized
  outcome: Localized
  tools: string[]
  note?: Localized
}

/** The whole document, as served by `/prompt-guide/api/guide`. */
export interface GuideDocument {
  plugin: string
  version: number
  categories: PromptCategory[]
  entries: PromptEntry[]
}

/** Payload revision; bump when the shape (not the wording) changes. */
export const GUIDE_VERSION = 1

/** Categories, in display order. */
export const CATEGORIES: PromptCategory[] = [
  {
    id: 'start',
    order: 10,
    title: { zh: '起步', en: 'Start here' },
    summary: {
      zh: '第一次进入工作区：把工程带进来，先弄清现状。',
      en: 'First contact: bring a project in and find out where things stand.',
    },
  },
  {
    id: 'read',
    order: 20,
    title: { zh: '读工程、问问题', en: 'Read the project' },
    summary: {
      zh: '不打开 TIA 也能回答的问题：结构、变量、调用、历史、文档。',
      en: 'Questions answerable without touching TIA: structure, tags, usage, history, documents.',
    },
  },
  {
    id: 'edit',
    order: 30,
    title: { zh: '改程序', en: 'Change the program' },
    summary: {
      zh: '改一个网络、加一个对象、编译验证。写操作一律先给计划。',
      en: 'Change one network, add an object, verify with a compile. Writes always plan first.',
    },
  },
  {
    id: 'version',
    order: 40,
    title: { zh: '版本与提交', en: 'Versions and commits' },
    summary: {
      zh: '同步 TIA 里的改动、看清差异、给改动一个原因、必要时重建索引。',
      en: 'Sync what changed in TIA, see the diff, record why, and rebuild the index when needed.',
    },
  },
  {
    id: 'sim',
    order: 50,
    title: { zh: '仿真', en: 'Simulation' },
    summary: {
      zh: 'PLCSIM Advanced 实例：下载、切 RUN、读写变量。',
      en: 'PLCSIM Advanced instances: download, switch to RUN, read and write tags.',
    },
  },
  {
    id: 'drawing',
    order: 60,
    title: { zh: '电气图纸', en: 'Drawings' },
    summary: {
      zh: '把 PDF 图纸索引成可检索的页与元件，并翻到那一页。',
      en: 'Index a PDF drawing into searchable sheets and elements, then turn to the right page.',
    },
  },
  {
    id: 'git',
    order: 70,
    title: { zh: 'Git 仓库', en: 'Git' },
    summary: {
      zh: '工作区是 git 仓库：看改动、提交、看历史、必要时回退。',
      en: 'The workspace is a git repository: inspect, commit, read history, and roll back when needed.',
    },
  },
  {
    id: 'ops',
    order: 80,
    title: { zh: '排障与协作', en: 'Troubleshooting and teamwork' },
    summary: {
      zh: '控制器卡住时先看什么；什么时候该让子 agent 去深挖。',
      en: 'What to look at when the controller misbehaves, and when to hand work to a subagent.',
    },
  },
  {
    id: 'commands',
    order: 90,
    title: { zh: '斜杠命令', en: 'Slash commands' },
    summary: {
      zh: '不经模型、由宿主直接执行的快捷操作；输入 / 可以看到全部。',
      en: 'Shortcuts the host runs directly, without the model. Type / to see them all.',
    },
  },
]

/** The cards. */
export const ENTRIES: PromptEntry[] = [
  // ---------------------------------------------------------------- start
  {
    id: 'start-project',
    category: 'start',
    order: 10,
    title: { zh: '把现有工程带进工作区', en: 'Bring an existing project into the workspace' },
    when: {
      zh: '工作区还没有工程，而你在 TIA Portal 里已经有一个 .ap17。',
      en: 'The workspace has no project yet and you already have an .ap17 in TIA Portal.',
    },
    prompt: {
      zh: '把这个 TIA 工程建到当前工作区：<工程路径>.ap17',
      en: 'Bring this TIA project into the current workspace: <path>.ap17',
    },
    outcome: {
      zh: 'TIA 打开（或复用）该工程，另存到工作区 tia/ 下，把源树导出到 source/，再逐设备建知识图谱库。默认先给计划、什么都不写；确认后才执行。',
      en: 'TIA opens (or reuses) the project, saves it under the workspace tia/, exports the source tree into source/, and builds a knowledge database per device. It plans first and writes nothing until you confirm.',
    },
    tools: ['create_engineering_project'],
    note: {
      zh: '另存会改变 TIA 当前持有的工程位置，所以是显式确认的一步；源目录里的文件不会被改。一个工作区只归一个工程。',
      en: 'Save-as moves the project TIA holds, which is why it is an explicit confirmation; files in the source folder are not modified. One workspace belongs to one project.',
    },
  },
  {
    id: 'start-status',
    category: 'start',
    order: 20,
    title: { zh: '先问清楚现状', en: 'Ask where things stand first' },
    when: {
      zh: '隔了几天回到这个工作区，或者不确定上次做到哪一步。',
      en: 'You are back after a few days, or you are not sure how far the last session got.',
    },
    prompt: {
      zh: '这个会话现在管哪个工程？源树、知识库和版本库分别是什么状态？',
      en: 'Which project does this session own? What is the state of the source tree, the knowledge bases and the version store?',
    },
    outcome: {
      zh: 'project_status 读证据账本、源树清单、git 状态与锁，只读不写；knowledge_workspace 报出每台设备的图谱库。',
      en: 'project_status reads the evidence ledger, the source manifest, git state and the lock, without writing; knowledge_workspace lists the database of every device.',
    },
    tools: ['project_status', 'knowledge_workspace'],
  },
  {
    id: 'start-onboarding',
    category: 'start',
    order: 30,
    title: { zh: '让模型先做一次自我介绍', en: 'Ask the agent to introduce the distribution' },
    when: {
      zh: '第一次用这个发行版，想先知道它和普通 DSH 有什么不同。',
      en: 'First time with this distribution and you want to know how it differs from plain DSH.',
    },
    prompt: {
      zh: '用三句话说明这个发行版能做什么，再告诉我第一次应该先做什么。',
      en: 'In three sentences, what can this distribution do? Then tell me what to do first.',
    },
    outcome: {
      zh: '模型按发行版 persona 与当前 preset 的工具面回答；缺什么能力会直说，不会假装有。',
      en: 'The agent answers from the distribution persona and the current preset tool surface; missing capabilities are named instead of imitated.',
    },
    tools: [],
    note: {
      zh: '这一页本身就回答了同一个问题——它是给人看的版本。',
      en: 'This page answers the same question: it is the human-readable version.',
    },
  },

  // ---------------------------------------------------------------- read
  {
    id: 'read-find-block',
    category: 'read',
    order: 10,
    title: { zh: '按功能找块', en: 'Find blocks by what they do' },
    when: {
      zh: '你只记得功能（“急停”“气缸复位”），不记得块名。',
      en: 'You remember the function ("emergency stop", "cylinder reset") but not the block name.',
    },
    prompt: {
      zh: '这台设备里哪些块和“急停”有关？把命中的块名和网络号列出来。',
      en: 'Which blocks on this device deal with the emergency stop? List the matching blocks and network numbers.',
    },
    outcome: {
      zh: '按功能检索走 knowledge_search（在只读专家 expert 名下），leader 会把问题派过去；已知块名时可直接用 knowledge_block / knowledge_network 展开。',
      en: 'Finding by function uses knowledge_search (held by the read-only expert), so the leader dispatches it; with a known block name, knowledge_block / knowledge_network expand it directly.',
    },
    tools: ['knowledge_search', 'knowledge_block', 'knowledge_network'],
  },
  {
    id: 'read-variable',
    category: 'read',
    order: 20,
    title: { zh: '追踪一个变量', en: 'Trace one tag' },
    when: {
      zh: '要改一个信号，但先要知道还有谁在读写它。',
      en: 'You are about to change a signal and need to know who else reads or writes it.',
    },
    prompt: {
      zh: '变量 btn_forward 在哪些块和网络里被读写？按读写分别列出。',
      en: 'Where is the tag btn_forward read and written? List reads and writes separately.',
    },
    outcome: {
      zh: 'knowledge_variable_usage 一次列出带块名与网络的引用点；它在专家名下，leader 会把这个问题派给专家，再把结果带回来。',
      en: 'knowledge_variable_usage lists the reference sites with block and network; it lives with the expert, so the leader delegates and reports back.',
    },
    tools: ['knowledge_variable_usage', 'knowledge_search'],
  },
  {
    id: 'read-structure',
    category: 'read',
    order: 30,
    title: { zh: '盘点工程结构', en: 'Take inventory of the project' },
    when: {
      zh: '接手一个陌生工程，想先知道规模与组成。',
      en: 'Taking over an unfamiliar project and want its size and composition first.',
    },
    prompt: {
      zh: '这台设备有多少个 FB、FC、DB？按编程语言分类统计一下。',
      en: 'How many FBs, FCs and DBs does this device have? Break the count down by programming language.',
    },
    outcome: {
      zh: 'knowledge_query 按图谱库的 schema 查询（先 knowledge_schema 看表结构）；库还没建时退回读 source/ 里的清单。',
      en: 'knowledge_query queries the knowledge database schema (call knowledge_schema first to see the tables); without a database it falls back to the manifest under source/.',
    },
    tools: ['knowledge_query', 'knowledge_schema'],
  },
  {
    id: 'read-problem',
    category: 'read',
    order: 40,
    title: { zh: '列出已知问题', en: 'List known problems' },
    when: {
      zh: '想知道导入时或历史分析里记下的问题，而不是重新审一遍代码。',
      en: 'You want the problems recorded during import or earlier analysis instead of a fresh review.',
    },
    prompt: {
      zh: '这个工程里记了哪些已知问题？按严重程度排一下。',
      en: 'Which known problems are recorded for this project? Order them by severity.',
    },
    outcome: {
      zh: 'project_problem 读图谱中 kind=Problem 的节点，只汇报已登记的，不顺手推断新问题。',
      en: 'project_problem reads the nodes of kind Problem; it reports what was recorded and does not invent new findings.',
    },
    tools: ['project_problem'],
  },
  {
    id: 'read-doc',
    category: 'read',
    order: 50,
    title: { zh: '查导入的文档', en: 'Search the imported documents' },
    when: {
      zh: '你手里有手册或说明，想按关键词找段落。',
      en: 'You have manuals or notes in the workspace and want a passage by keyword.',
    },
    prompt: {
      zh: '在我们导入的文档里找关于“安全程序”的说明，把出处和原文引出来。',
      en: 'Search the imported documents for the safety-program description and quote the source.',
    },
    outcome: {
      zh: '先 project_doc_index 建索引（一次性），再 project_doc_search 检索；返回文件与位置，不改文档。',
      en: 'project_doc_index builds the index once, then project_doc_search retrieves hits with file and position; documents are never modified.',
    },
    tools: ['project_doc_index', 'project_doc_search'],
  },
  {
    id: 'read-history',
    category: 'read',
    order: 60,
    title: { zh: '一个块的历史', en: 'History of one block' },
    when: {
      zh: '想知道某个块最近改了什么、为什么改。',
      en: 'You want to know what changed in one block recently, and why.',
    },
    prompt: {
      zh: 'FB_Conveyor 最近三次改动分别改了什么？原因写的是什么？',
      en: 'What changed in the last three revisions of FB_Conveyor, and what reasons were recorded?',
    },
    outcome: {
      zh: 'project_history 读版本账本（提交、变更事件、逐 face 指纹），不重跑 SQL；project_version_query 可按对象与时间窗筛选。',
      en: 'project_history reads the version ledger (commits, change events, per-face fingerprints) without re-querying SQL; project_version_query filters by object and time window.',
    },
    tools: ['project_history', 'project_version_query'],
  },

  // ---------------------------------------------------------------- edit
  {
    id: 'edit-network',
    category: 'edit',
    order: 10,
    title: { zh: '改一个网络的逻辑', en: 'Change the logic of one network' },
    when: {
      zh: '明确的单点修改：一个触点、一段置位复位、一个接口成员。',
      en: 'A concrete single-point change: one contact, one set/reset, one interface member.',
    },
    prompt: {
      zh: '把 FB_Conveyor 的 Network 3 里那个常开触点改成常闭，编译通过后告诉我结果。',
      en: 'Change the normally-open contact in Network 3 of FB_Conveyor to normally-closed, and tell me the compile result.',
    },
    outcome: {
      zh: '打开工程 → 只导出目标块 → 只改目标网络 → 以 override 导入 → 编译。不会拿别的块的文件当模板。',
      en: 'Open the project, export only the target block, edit only the target network, import with override, compile. No other block is used as a template.',
    },
    tools: ['open_project', 'export_blocks', 'import_blocks', 'compile_plc'],
    note: {
      zh: '导入必须只包含你真正想改的内容——override 会整体替换那个块。',
      en: 'The import must contain only what you mean to change: override replaces the whole block.',
    },
  },
  {
    id: 'edit-create',
    category: 'edit',
    order: 20,
    title: { zh: '新建对象（先 dry run）', en: 'Create objects (dry run first)' },
    when: {
      zh: '需要加一个 DB、FB、FC、变量表或 PLC 类型。',
      en: 'You need a new DB, FB, FC, tag table or PLC type.',
    },
    prompt: {
      zh: '在这个 PLC 里新建一个全局 DB，名字叫 DB_Test，先 dry run 给我看要做什么。',
      en: 'Create a global DB named DB_Test in this PLC, and dry-run it first so I can see the plan.',
    },
    outcome: {
      zh: 'create_plc_objects 默认 dry_run：先解析目标、报冲突；确认后才真正创建。',
      en: 'create_plc_objects defaults to dry_run: it resolves targets and reports conflicts, and writes only after you confirm.',
    },
    tools: ['create_plc_objects', 'list_plc_objects'],
  },
  {
    id: 'edit-attributes',
    category: 'edit',
    order: 30,
    title: { zh: '批量改块属性', en: 'Change block attributes in bulk' },
    when: {
      zh: '要统一改一批块的属性（编号、注释、保护、语言等）。',
      en: 'You want one attribute applied across a batch of blocks (numbering, comments, protection, language).',
    },
    prompt: {
      zh: '把这些块的语言都改成 SCL，先给我一份 dry run 清单。',
      en: 'Set the language of these blocks to SCL, and give me a dry-run list first.',
    },
    outcome: {
      zh: 'set_block_attributes 批量写，先校验对象是否存在、冲突有哪些；报告逐块结果。',
      en: 'set_block_attributes writes in bulk after validating existence and conflicts, and reports a per-block result.',
    },
    tools: ['set_block_attributes'],
  },
  {
    id: 'edit-compile',
    category: 'edit',
    order: 40,
    title: { zh: '只做编译检查', en: 'Compile only' },
    when: {
      zh: '改完想确认没有引入错误，不想动别的。',
      en: 'You changed something and want to confirm it did not break the build.',
    },
    prompt: {
      zh: '编译一遍这个 PLC，把错误和警告按块列出来。',
      en: 'Compile this PLC and list errors and warnings by block.',
    },
    outcome: {
      zh: 'compile_plc 返回 state、错误数、警告数和逐条消息；编译错误是数据，不是工具失败。',
      en: 'compile_plc returns the state, error and warning counts and the individual messages; compile errors are data, not a tool failure.',
    },
    tools: ['compile_plc'],
    note: {
      zh: '编译会改变工程的编译状态；大工程可能十分钟以上，别按秒级超时判断失败。',
      en: 'Compiling changes the project compile state; a large project can take ten minutes, so do not read a slow return as a failure.',
    },
  },

  // ---------------------------------------------------------------- version
  {
    id: 'version-sync',
    category: 'version',
    order: 10,
    title: { zh: '同步并解释差异', en: 'Sync and explain the diff' },
    when: {
      zh: '在 TIA 里改了东西，想让工作区的源树与记录跟上。',
      en: 'You changed something in TIA and want the workspace tree and record to catch up.',
    },
    prompt: {
      zh: '把 TIA 里的改动同步到工作区，然后告诉我具体变了什么。',
      en: 'Sync the changes from TIA into the workspace, then tell me exactly what changed.',
    },
    outcome: {
      zh: 'project_sync 重写 source/，project_diff 按对象列出变更。这两步是分钟级任务，leader 会派给版本管家（auditor）执行，再把事实带回来。',
      en: 'project_sync rewrites source/ and project_diff lists changes per object. Both are minute-scale jobs the leader hands to the auditor and reports back.',
    },
    tools: ['project_sync', 'project_diff'],
    note: {
      zh: '同步只写源树，不写历史；要留痕还得提交一次。',
      en: 'Syncing writes the tree, not the history; a commit is what records it.',
    },
  },
  {
    id: 'version-commit',
    category: 'version',
    order: 20,
    title: { zh: '提交并写清原因', en: 'Commit with a reason' },
    when: {
      zh: '一次修改完成、编译通过，准备留档。',
      en: 'A change is done and compiles, and you want it on the record.',
    },
    prompt: {
      zh: '把这次修改提交，原因写：修正急停回路的自锁。',
      en: 'Commit this change with the reason: fix the latch in the emergency-stop circuit.',
    },
    outcome: {
      zh: 'project_commit 把源树、变更原因、指纹与 git 提交一起记进版本账本；提交信息会先让你确认。',
      en: 'project_commit records the tree, the reason, the fingerprints and a git commit in the version ledger; the message is confirmed with you first.',
    },
    tools: ['project_commit'],
  },
  {
    id: 'version-annotate',
    category: 'version',
    order: 30,
    title: { zh: '给一版加标注', en: 'Annotate a version' },
    when: {
      zh: '这一版有现场含义（调试通过、交付客户），值得一句话说明。',
      en: 'A version has field meaning (commissioned, delivered) and deserves one sentence.',
    },
    prompt: {
      zh: '给最近这一版加标注：现场调试后确认可用。',
      en: 'Annotate the latest version: confirmed working after on-site commissioning.',
    },
    outcome: {
      zh: 'project_version_annotate 只写标注，不改代码、不产生新版本。',
      en: 'project_version_annotate writes the annotation only; no code changes and no new version.',
    },
    tools: ['project_version_annotate'],
  },
  {
    id: 'version-verify',
    category: 'version',
    order: 40,
    title: { zh: '校验版本库与图谱', en: 'Verify the store and the graph' },
    when: {
      zh: '怀疑账本、源树与图谱对不上，或者刚经历过中断。',
      en: 'You suspect the ledger, tree and graph disagree, or a run was interrupted.',
    },
    prompt: {
      zh: '校验一下版本库和图谱是否一致，不一致就重建索引。',
      en: 'Verify that the version store and the graph agree, and rebuild the index if they do not.',
    },
    outcome: {
      zh: 'project_version_verify 比对账本；project_version_reindex 从已落盘的源树重建派生索引。',
      en: 'project_version_verify compares the ledger; project_version_reindex rebuilds the derived index from the source tree already on disk.',
    },
    tools: ['project_version_verify', 'project_version_reindex'],
  },

  // ---------------------------------------------------------------- sim
  {
    id: 'sim-download',
    category: 'sim',
    order: 10,
    title: { zh: '起仿真并下载', en: 'Start a simulation and download' },
    when: {
      zh: '没有真机，想在 PLCSIM Advanced 里跑一遍程序。',
      en: 'No real PLC available and you want to run the program in PLCSIM Advanced.',
    },
    prompt: {
      zh: '用 PLCSIM Advanced 起一个 1511 实例，把当前 PLC 下载进去，然后切到 RUN。',
      en: 'Start a 1511 instance in PLCSIM Advanced, download the current PLC into it, then switch it to RUN.',
    },
    outcome: {
      zh: 'simulation_instance 创建并上电，download 直连虚拟目标下载，simulation_run 切 RUN；每一步的写操作都要 confirm。',
      en: 'simulation_instance creates and powers on, download targets the virtual CPU directly, simulation_run switches to RUN; each writing step needs confirm.',
    },
    tools: ['simulation_instance', 'download', 'simulation_run'],
    note: {
      zh: '第一台实例在下载前不能上线，所以下载要用直连目标的形式；下载本身默认 dry_run。',
      en: 'A fresh instance cannot go online before its first download, so the direct-target form is used; download itself defaults to dry_run.',
    },
  },
  {
    id: 'sim-tags',
    category: 'sim',
    order: 20,
    title: { zh: '读写仿真变量', en: 'Read and write simulation tags' },
    when: {
      zh: '想在仿真里手动给一个输入、看一个输出。',
      en: 'You want to force an input and watch an output in the simulation.',
    },
    prompt: {
      zh: '把仿真里的 StartButton 置为 true，然后读回 MotorRunning。',
      en: 'Set StartButton to true in the simulation, then read back MotorRunning.',
    },
    outcome: {
      zh: 'simulation_tags 支持 Bool、整数族与 Real/LReal；写需要 value 与 confirm，读之前会刷新变量表。',
      en: 'simulation_tags supports Bool, the integer families and Real/LReal; a write needs value and confirm, and the tag table is refreshed before each call.',
    },
    tools: ['simulation_tags', 'simulation_status'],
  },

  // ---------------------------------------------------------------- drawing
  {
    id: 'drawing-open',
    category: 'drawing',
    order: 10,
    title: { zh: '导入图纸并建索引', en: 'Ingest a drawing and index it' },
    when: {
      zh: '有一份 PDF 电气图，想按元件或页号检索。',
      en: 'You have a PDF electrical drawing and want to search it by element or sheet.',
    },
    prompt: {
      zh: '把这张电气图导入工作区并建立索引：<图纸路径>.pdf',
      en: 'Ingest this electrical drawing into the workspace and index it: <path>.pdf',
    },
    outcome: {
      zh: 'drawing_open 把原件复制进工作区 drawing/ 并解析一次，生成页、交叉引用与命名元件索引；原件不动，重复导入未变的文件直接用缓存。',
      en: 'drawing_open copies the original into the workspace drawing/ and parses it once into sheets, cross references and named elements; the original is untouched and an unchanged re-import uses the cache.',
    },
    tools: ['drawing_open', 'drawing_status'],
  },
  {
    id: 'drawing-find',
    category: 'drawing',
    order: 20,
    title: { zh: '在图纸里找元件', en: 'Find an element in the drawing' },
    when: {
      zh: '知道元件号（KM1、X3、W015、%I400.3），想知道画在哪几页。',
      en: 'You know the tag (KM1, X3, W015, %I400.3) and want the sheets that draw it.',
    },
    prompt: {
      zh: '在图纸里找 KM1 出现在哪些页，把页号和区域给我，并翻到第一处。',
      en: 'Find which sheets draw KM1, give me the sheet numbers and areas, and turn to the first one.',
    },
    outcome: {
      zh: 'drawing_search 返回页码与框，drawing_sheet 读该页的标题栏、元件与交叉引用，drawing_show 在右侧栏 Drawing 标签里翻到那页并高亮。',
      en: 'drawing_search returns pages with boxes, drawing_sheet reads a sheet’s title block, elements and cross references, and drawing_show opens the Drawing tab at that page with the box highlighted.',
    },
    tools: ['drawing_search', 'drawing_sheet', 'drawing_show'],
  },

  // ---------------------------------------------------------------- git
  {
    id: 'git-review',
    category: 'git',
    order: 10,
    title: { zh: '提交前先看改动', en: 'Review before committing' },
    when: {
      zh: '工作区里有一批改动，提交前想先确认内容。',
      en: 'The workspace has a batch of changes and you want to see them before committing.',
    },
    prompt: {
      zh: '看看工作区现在改了什么，按文件列出来，再决定要不要提交。',
      en: 'Show me what changed in the workspace, grouped by file, before we commit anything.',
    },
    outcome: {
      zh: 'git_status 列状态，git_diff 给逐行差异；这一步只读。',
      en: 'git_status lists the state and git_diff shows the line-level changes; both are read-only.',
    },
    tools: ['git_status', 'git_diff', 'git_stage'],
  },
  {
    id: 'git-history',
    category: 'git',
    order: 20,
    title: { zh: '看历史与分支', en: 'Read history and branches' },
    when: {
      zh: '想知道最近谁改了什么，或者当前在哪个分支。',
      en: 'You want the recent commits, or to know which branch you are on.',
    },
    prompt: {
      zh: '列出最近 10 个提交和当前分支，说明每个提交碰了哪些文件。',
      en: 'List the last ten commits and the current branch, and say which files each commit touched.',
    },
    outcome: {
      zh: 'git_log 给提交列表，git_show 展开某个提交，git_branch / git_remote 看分支与远端。',
      en: 'git_log lists commits, git_show expands one, and git_branch / git_remote report branches and remotes.',
    },
    tools: ['git_log', 'git_show', 'git_branch', 'git_remote'],
  },
  {
    id: 'git-rollback',
    category: 'git',
    order: 30,
    title: { zh: '回到上一个状态', en: 'Get back to an earlier state' },
    when: {
      zh: '刚做的改动不对，想回到提交前或某个旧提交。',
      en: 'The last change was wrong and you want the state before the commit, or an older commit.',
    },
    prompt: {
      zh: '把刚才未提交的改动先 stash 起来，我要回到干净状态确认一下。',
      en: 'Stash the uncommitted changes so I can verify the clean state first.',
    },
    outcome: {
      zh: 'git_stash 暂存改动；git_checkout 切分支或恢复文件。影响工作区的操作会先说明再执行。',
      en: 'git_stash shelves the changes; git_checkout switches branches or restores files. Anything that changes the working tree is explained before it runs.',
    },
    tools: ['git_stash', 'git_checkout'],
    note: {
      zh: '改写历史（reset --hard、force push）不在默认能力里——真要做，模型会先向你确认。',
      en: 'Rewriting history (reset --hard, force push) is not a default capability; the agent asks you first if it is ever needed.',
    },
  },

  // ---------------------------------------------------------------- ops
  {
    id: 'ops-controller',
    category: 'ops',
    order: 10,
    title: { zh: 'TIA 控制器像是卡住了', en: 'The TIA controller looks stuck' },
    when: {
      zh: '某个 TIA 工具长时间不回、或者报出没见过错误。',
      en: 'A TIA tool is taking very long or returned an unfamiliar error.',
    },
    prompt: {
      zh: 'TIA 控制器是不是卡住了？帮我看看状态和最近的错误。',
      en: 'Is the TIA controller stuck? Check its state and the last error.',
    },
    outcome: {
      zh: 'controller_status 报告子进程是否在跑、Openness 是否可用、当前用户是否在 Openness 用户组、请求数与最后错误；它不会启动 TIA。',
      en: 'controller_status reports whether the subprocess runs, whether Openness is available, whether the user is in the Openness group, the request count and the last error. It never starts TIA.',
    },
    tools: ['controller_status', '/tia-status'],
  },
  {
    id: 'ops-expert',
    category: 'ops',
    order: 20,
    title: { zh: '让专家深挖一个块', en: 'Send an expert after one block' },
    when: {
      zh: '要通读一个块的多个网络、追踪调用链，问题不是一句话能答的。',
      en: 'One block spans many networks and the answer is not a one-liner.',
    },
    prompt: {
      zh: '派一个专家子 agent 把 FB_Conveyor 的时序和调用链彻底读一遍，给我结论和改动建议。',
      en: 'Send an expert subagent to read FB_Conveyor’s timing and call chain thoroughly, and come back with conclusions and a change plan.',
    },
    outcome: {
      zh: 'leader 派出只读的 expert（可并行，上限 2），拿回合并结论、逐网络覆盖率与修改建议；它不能写工程。',
      en: 'The leader dispatches a read-only expert (at most two in parallel) and gets back a consolidated answer, per-network coverage and a change plan; it cannot write the project.',
    },
    tools: ['subagent'],
  },
  {
    id: 'ops-auditor',
    category: 'ops',
    order: 30,
    title: { zh: '把版本活交给版本管家', en: 'Hand version work to the auditor' },
    when: {
      zh: '要建库、同步、跑差异、提交或刷新图谱——这些是分钟级任务。',
      en: 'You need a database build, a sync, a diff, a commit or a graph refresh: minute-scale jobs.',
    },
    prompt: {
      zh: '让版本管家把这次改动同步、跑一遍差异，再写提交信息；提交前先问我。',
      en: 'Have the auditor sync this change, run the diff and draft a commit message; ask me before committing.',
    },
    outcome: {
      zh: 'leader 派 auditor 执行 create / status / sync / diff / commit / ingest；提交信息由 leader 转问你确认。',
      en: 'The leader dispatches the auditor for create / status / sync / diff / commit / ingest, and relays the commit message to you for confirmation.',
    },
    tools: ['subagent', 'project_sync', 'project_diff', 'project_commit'],
  },

  // ---------------------------------------------------------------- commands
  {
    id: 'cmd-status',
    category: 'commands',
    order: 10,
    title: { zh: '/tia-status', en: '/tia-status' },
    when: { zh: '怀疑控制器有问题，先做一次便宜的检查。', en: 'You suspect the controller and want a cheap check first.' },
    prompt: { zh: '/tia-status', en: '/tia-status' },
    outcome: {
      zh: '不启动 TIA，直接读控制器的当前快照。',
      en: 'Reads the controller snapshot without starting TIA.',
    },
    tools: ['/tia-status'],
  },
  {
    id: 'cmd-info',
    category: 'commands',
    order: 20,
    title: { zh: '/tia-info', en: '/tia-info' },
    when: {
      zh: '想快速知道当前项目的属主、版本、设备与 PLC 软件。',
      en: 'You want the current project’s owner, version, devices and PLC software.',
    },
    prompt: { zh: '/tia-info devices software', en: '/tia-info devices software' },
    outcome: {
      zh: '按参数列出项目概要；可加 attributes / comment / languages / history / products / settings。',
      en: 'Lists the project summary; attributes / comment / languages / history / products / settings are optional selectors.',
    },
    tools: ['/tia-info'],
  },
  {
    id: 'cmd-find',
    category: 'commands',
    order: 30,
    title: { zh: '/tia-find', en: '/tia-find' },
    when: {
      zh: '记得名字的一部分，想快速定位块、类型或变量表。',
      en: 'You remember part of a name and want to locate a block, type or tag table.',
    },
    prompt: { zh: '/tia-find conveyor --blocks', en: '/tia-find conveyor --blocks' },
    outcome: {
      zh: '按子串搜索当前项目，--blocks / --types / --tables / --units 限定家族。',
      en: 'Searches the open project by substring; --blocks / --types / --tables / --units narrow the family.',
    },
    tools: ['/tia-find'],
  },
  {
    id: 'cmd-compile',
    category: 'commands',
    order: 40,
    title: { zh: '/tia-compile', en: '/tia-compile' },
    when: { zh: '只想编译当前 PLC，看错误与警告。', en: 'Compile the current PLC and see errors and warnings.' },
    prompt: { zh: '/tia-compile', en: '/tia-compile' },
    outcome: {
      zh: '编译当前 PLC，首行给出结论，展开看逐条消息。',
      en: 'Compiles the current PLC; the first line is the verdict and the card holds the messages.',
    },
    tools: ['/tia-compile'],
  },
  {
    id: 'cmd-open-close',
    category: 'commands',
    order: 50,
    title: { zh: '/tia-open 与 /tia-close', en: '/tia-open and /tia-close' },
    when: { zh: '手动打开本工作区的工程，或收工时保存并关闭。', en: 'Open the workspace project by hand, or save and close at the end of a shift.' },
    prompt: { zh: '/tia-open', en: '/tia-open' },
    outcome: {
      zh: 'open 只开本工作区已有的工程；close 会先保存再关闭项目与 TIA Portal。',
      en: 'open only opens a project this workspace already owns; close saves first, then closes the project and TIA Portal.',
    },
    tools: ['/tia-open', '/tia-close', '/tia-save'],
  },
]

/** Every tool name the suite exposes, for the "advertised capability is wired" test. */
export const TOOL_CATALOG: string[] = [
  // TIA Portal interface (V17)
  'open_project',
  'close_project',
  'save_project',
  'project_info',
  'export_blocks',
  'import_blocks',
  'compile_plc',
  'create_plc_objects',
  'delete_plc_objects',
  'list_plc_objects',
  'set_block_attributes',
  'write_tags',
  'generate_source',
  'update_project',
  'project_languages',
  'project_texts',
  'software_units',
  'protect_blocks',
  'watch_and_force_tables',
  'safety_status',
  'set_safety_settings',
  'safety_signatures',
  'adopt_open_project',
  'archive_project',
  'online_targets',
  'online_connect',
  'online_status',
  'online_disconnect',
  'download',
  'hardware_view',
  'export_hardware_config',
  'hardware_inventory',
  'hardware_configuration',
  'hardware_parameters',
  'controller_status',
  'create_project',
  'portal_settings',
  // Engineering context
  'create_engineering_project',
  'project_status',
  'project_sync',
  'project_commit',
  'project_diff',
  // Version store
  'project_history',
  'project_version_reindex',
  'project_version_verify',
  'project_version_annotate',
  'project_version_query',
  'project_doc_index',
  'project_doc_search',
  'project_problem',
  // Knowledge graph
  'knowledge_workspace',
  'knowledge_schema',
  'knowledge_ingest',
  'knowledge_update',
  'knowledge_query',
  'knowledge_search',
  'knowledge_block',
  'knowledge_network',
  'knowledge_networks',
  'knowledge_network_accesses',
  'knowledge_variable_usage',
  // PLCSIM Advanced
  'simulation_status',
  'simulation_instance',
  'simulation_run',
  'simulation_tags',
  // Drawings
  'drawing_status',
  'drawing_open',
  'drawing_search',
  'drawing_sheet',
  'drawing_show',
  // Git
  'git_status',
  'git_diff',
  'git_log',
  'git_branch',
  'git_stage',
  'git_commit',
  'git_stash',
  'git_show',
  'git_fetch',
  'git_pull',
  'git_remote',
  'git_checkout',
  // Delegation and commands
  'subagent',
  '/tia-open',
  '/tia-save',
  '/tia-compile',
  '/tia-close',
  '/tia-info',
  '/tia-find',
  '/tia-status',
]

/**
 * The document the page receives.
 *
 * A fresh object each call keeps a caller from mutating the module-level data
 * (the host serialises it once, but tests and future routes may not).
 *
 * @returns `{ plugin, version, categories, entries }`.
 */
export function guideDocument(): GuideDocument {
  return {
    plugin: 'dsh-ui-prompt-guide',
    version: GUIDE_VERSION,
    categories: CATEGORIES.map((category) => ({ ...category })),
    entries: ENTRIES.map((entry) => ({ ...entry, tools: [...entry.tools] })),
  }
}
