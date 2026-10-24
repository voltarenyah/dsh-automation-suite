/**
 * Curated knowledge of the TIA Portal Openness V17 coverage matrix.
 *
 * This is the only hand-maintained part of the matrix. Everything numeric
 * (manual leaf counts, API type counts, which Openness types the controller
 * actually references, the operation/tool inventory) is derived from
 * `docs/coverage-matrix.sources.json` and the live sources by
 * `scripts/coverage/build-matrix.mjs`.
 *
 * Two rules keep this file honest:
 *
 *   - `path` locates a node in the manual's table of contents exactly as the
 *     official V17 help writes it. A path that no longer resolves is a build
 *     error, not a silently skipped row.
 *   - a leaf override whose title does not exist under its section is reported
 *     as a warning, so a manual update cannot quietly orphan a row.
 *
 * A TIA version bump therefore has exactly two touch points:
 * `npm run matrix:extract` (new snapshots) and the paths/titles here.
 *
 * @module scripts/coverage/matrix-data
 */

/**
 * Preconditions the official manual attaches to a capability. `code` is what
 * the matrix prints; `text` is the hover explanation.
 */
export const PRECONDITIONS = {
  G: {
    label: '组成员',
    text:
      'Windows 本地组 "Siemens TIA Openness" 的成员身份（直接或经其他组间接加入）。\n' +
      '手册 Installation 章明示：加组只能用操作系统工具，"The TIA Portal does not support this operation"，' +
      '通常需要管理员权限，且改完要重新登录。',
  },
  W: {
    label: '白名单',
    text:
      'TIA Portal Openness firewall / 应用白名单（手册同名章节）。\n' +
      '注册表键 HKLM\\SOFTWARE\\Siemens\\Automation\\Openness\\<ver>\\Whitelist\\<App>.exe，含 Path / DateModified / FileHash。\n' +
      '手册：提示只在"连接到正在运行的 TIA Portal"时出现 —— 自启无界面实例不会触发。',
  },
  E: {
    label: '环境',
    text:
      '同机装有基于 TIA Portal 的产品（如 STEP 7 Professional / WinCC Professional）与 TIA Portal Openness；' +
      '手册另要求 .NET Framework SDK 4.8，并约定 remoting IpcChannel（ensureSecurity=false、priority=1、typeFilterLevel=Full）。',
  },
  P: {
    label: '实机',
    text: '需要真实 PLC / PLCSIM、项目服务器或对应许可，无法在纯离线工程上验证。',
  },
  D: {
    label: '界面',
    text: '依赖桌面交互：独占访问对话框、块编辑器、Devices & networks 编辑器等；无界面模式下行为不同或不可用。',
  },
}

/**
 * Limitations the manual states outright, plus two the controller hit in a real
 * project run. Each entry quotes the manual topic it comes from.
 */
export const REFUSALS = {
  R0: {
    label: '无 API',
    text: '手册 "Adding users to the \\"Siemens TIA Openness\\" user group"：加组无法通过 TIA Portal API 完成。',
  },
  R1: {
    label: 'F 系统块',
    text: '手册 "Exporting failsafe blocks"：F 块可以导入导出，**F-system 块不能导出**（工程实测 FOB_SAFETY 报 "export is not permitted"）。',
  },
  R2: {
    label: '库对象',
    text: '手册 "Exporting configuration data"：库中的对象类型不支持导出。',
  },
  R3: {
    label: '集成连接',
    text: '手册 "Exporting connections"：集成连接（integrated connections）不支持导出。',
  },
  R4: {
    label: '多语言文本',
    text: '手册 "Export of project texts"：多语言文本不能单独导出，只能随父对象一起导出。',
  },
  R5: {
    label: '外部源组',
    text: '手册 "Adding an external file" / "Deleting an external file"：External source files 组的组层级不可访问。',
  },
  R6: {
    label: '地址属性',
    text: '手册 "Accessing attributes of an address object"：压缩地址（packed addresses）在 Openness 中不支持；改地址不会重连已分配的标签。',
  },
  R7: {
    label: '跨子树引用',
    text: '手册 "Basic principles of importing/exporting"：非同一子树的被引用对象无法完整导入导出，只能以 open reference 形式进出。',
  },
  R8: {
    label: '库版本状态',
    text: '手册 "Accessing blocks located in library"：处于 in-work 状态的库版本数据不可导出。',
  },
  R9: {
    label: '无批量导出',
    text: '手册 "Exporting all screen templates of an HMI device" 等：不支持批量导出，必须逐个对象枚举后导出。',
  },
  R10: {
    label: 'psc 分步',
    text: '手册 "Creating and exporting psc file"：创建 .psc 与打开 .psc 不能分成两个命令执行。',
  },
  R11: {
    label: '归档模式',
    text: '手册 "Archiving and Retrieving a project"：以 ProjectArchivationMode.None 或 DiscardRestorableData 归档的工程无法被该 API 取回。',
  },
  R12: {
    label: '厂商属性',
    text: '手册 "Export/Import vendor specific attribute"：Manufacturer 属性 Openness 不支持，须经 Transformation Plugin 传递。',
  },
  R13: {
    label: 'AML 长度限',
    text: '手册 "Export of device item objects"：ProductDesignation IEC 超过 54 字符时不可导入；Length=0 的地址不可导入导出。',
  },
  R14: {
    label: 'ProDiag',
    text: '手册 "Accessing supervisions and properties of ProDiag-FB"：多属性 SetAttributes 会抛异常、不支持的属性抛可恢复异常；工程实测 ProDiag_OB 语言不可导入导出。',
  },
  R15: {
    label: '力表只读',
    text: 'V17 的 PlcForceTableComposition 只有 Import/Find，PlcForceTable 没有 Delete（Siemens.Engineering.dll V17 反射实证）：力表只能靠导入建立或替换，不能经 Openness 创建或删除。',
  },
  R16: {
    label: 'F 不可下载',
    text:
      '手册 "Downloading hardware and software components to PLC device"：F-activated PLCs are not supported for download operation。' +
      'F 块本身可以导入导出（见限制 R1），但把整个 F 程序下载到设备没有 Openness API —— F 激活的 CPU 只能走 TIA UI 下载。',
  },
}

/** Status codes used by both sections and leaves. */
export const STATUS = {
  done: { label: '已适配', order: 0 },
  partial: { label: '部分', order: 1 },
  none: { label: '未适配', order: 2 },
  na: { label: '—', order: 3 },
}

/** `compile` codes for the "可编译" column. */
export const COMPILE = {
  yes: { label: '✓', text: '该能力对应的类型在当前 NuGet 引用配置下可以编译到（PublicAPI\\V17\\*.dll 全量引用，CopyLocal=false）。' },
  no: { label: '✗', text: 'Openness 没有提供该能力的 API，代码层面无法实现。' },
  na: { label: '—', text: '这一条不是 API 能力（前置条件、合规声明或版本变更说明）。' },
}

/**
 * The matrix. Order is the manual's order so the page reads like the manual.
 *
 * Per section:
 *   path      - location in the manual TOC (must resolve)
 *   api       - Openness namespaces that carry the capability (for the
 *               auto-computed type coverage column); [] = not API-shaped
 *   pre       - precondition codes inherited by every leaf
 *   reject    - refusal codes inherited by every leaf
 *   compile   - inherited "可编译" code
 *   default   - inherited status for leaves without an override
 *   note      - section hover text
 *   leaves    - per-leaf overrides, matched by exact TOC title
 */
export const SECTIONS = [
  // ---------------------------------------------------------------- front matter
  {
    path: ['Security note'],
    api: [],
    compile: 'na',
    pre: [],
    reject: [],
    default: 'na',
    note: '西门子工业安全声明，不含 API 能力。分发 Openness 应用时按 THIRD_PARTY_NOTICES.md 处理。',
  },
  {
    path: ["What's new in TIA Portal Openness?"],
    api: [],
    compile: 'na',
    pre: [],
    reject: [],
    default: 'na',
    note: '版本新增说明；V17 具体增补未在矩阵中逐条建模。',
  },
  {
    path: ['Basics', 'Requirements for TIA Portal Openness'],
    api: [],
    compile: 'na',
    pre: ['E'],
    reject: [],
    default: 'na',
    note:
      '前置条件章节。手册要求表允许用户程序为 32 位/64 位/Any CPU，而本控制器固定 x64（csproj PlatformTarget），' +
      '差异应记为"待确认"而非手册要求。plugin 有 Openness 探测（controller_status）。',
  },
  {
    path: ['Basics', 'Installation'],
    api: [],
    compile: 'na',
    pre: ['G', 'E'],
    reject: ['R0'],
    default: 'na',
    note: '安装与本机身份配置。控制器不实现任何安装/加组动作，只做只读探测。',
    leaves: {
      'Adding users to the "Siemens TIA Openness" user group': {
        status: 'partial',
        compile: 'no',
        reject: ['R0'],
        note:
          '手册明示 TIA Portal 不支持该操作，只能用操作系统工具（管理员权限、改完重新登录）。' +
          '插件实现了组成员探测（Program.cs:611-641、controller_status 的 opennessUserGroup），' +
          '不实现加组；Siemens 的 Resolver 包另有 AddUserToGroupAsync，属超出 Openness 手册范围的能力，本插件未接线。',
      },
      'Accessing the TIA Portal': {
        status: 'done',
        note: '已实现：无界面自启实例、附加到运行中实例（with_window）。',
      },
    },
  },
  {
    path: ['Basics', 'Openness tasks'],
    api: [],
    compile: 'na',
    pre: [],
    reject: [],
    default: 'na',
    note: '任务总览（Applications / Export/import），描述 Openness 的适用场景。',
  },
  {
    path: ['Basics', 'Object list'],
    api: [],
    compile: 'na',
    pre: [],
    reject: [],
    default: 'na',
    note: '手册的对象清单；本插件只覆盖 PlcSoftware 子树的一小部分，未逐条核对。',
  },
  {
    path: ['Basics', 'Setting attributes of Blocks, DBs & UDTs'],
    api: ['Siemens.Engineering'],
    compile: 'yes',
    pre: [],
    reject: [],
    default: 'partial',
    note:
      '属性读写通用机制（IEngineeringObject.SetAttribute / GetAttributeInfos、EngineeringAttributeInfo）。' +
      '插件只做只读属性枚举（OpennessHost.cs:649-660），不做通用属性写入。',
  },
  {
    path: ['Basics', 'Standard libraries'],
    api: ['Siemens.Engineering.Library'],
    compile: 'yes',
    pre: [],
    reject: ['R2'],
    default: 'none',
    note: '标准库对象；插件不访问任何库。',
  },
  {
    path: ['Basics', 'Notes on performance of TIA Portal Openness'],
    api: [],
    compile: 'na',
    pre: [],
    reject: [],
    default: 'na',
    note: '性能建议（对象遍历成本、进程模型）。插件的队列/串行化与之相关但不属于该条能力。',
  },
  {
    path: ['Introduction'],
    api: [],
    compile: 'na',
    pre: [],
    reject: [],
    default: 'na',
    note: '手册导言。',
  },
  {
    path: ['Configurations'],
    api: ['Siemens.Engineering'],
    compile: 'yes',
    pre: ['E', 'D'],
    reject: [],
    default: 'partial',
    note:
      '进程内/进程外与用户界面模式配置。插件用 TiaPortalMode 覆盖了无界面自启与附加运行中实例两条路径，' +
      '其余配置项（语言、进程复用策略等）未适配。',
  },

  // ------------------------------------------------------------ API overview rows
  {
    path: ['TIA Portal Openness API', 'Introduction'],
    api: [],
    compile: 'na',
    pre: [],
    reject: [],
    default: 'na',
    note: 'API 章导言。',
  },
  {
    path: ['TIA Portal Openness API', 'Programming steps'],
    api: [],
    compile: 'na',
    pre: [],
    reject: [],
    default: 'na',
    note: '编程步骤（引程序集、解析器注册、连接、独占访问、释放）——插件按此实现，属流程说明。',
  },
  {
    path: ['TIA Portal Openness API', 'TIA Portal Openness object model'],
    api: [],
    compile: 'na',
    pre: [],
    reject: [],
    default: 'na',
    note: '对象模型总览。',
  },
  {
    path: ['TIA Portal Openness API', 'Blocks and types of the TIA Portal Openness object model'],
    api: [],
    compile: 'na',
    pre: [],
    reject: [],
    default: 'na',
    note: '对象模型的块与类型说明。',
  },
  {
    path: ['TIA Portal Openness API', 'Hierarchy of hardware objects of the object model'],
    api: [],
    compile: 'na',
    pre: [],
    reject: [],
    default: 'na',
    note: '硬件对象层级说明；插件的设备/设备项遍历按其层级实现。',
  },
  {
    path: ['TIA Portal Openness API', 'Information about installed TIA Portal Openness versions'],
    api: ['Siemens.Engineering'],
    compile: 'yes',
    pre: ['E'],
    reject: [],
    default: 'done',
    note: '已实现：控制器按注册表 PublicAPI 键 + 目录探测本机 V17 Openness，并在 controller_status 里报告可用性与文件版本。',
  },
  {
    path: ['TIA Portal Openness API', 'Example program'],
    api: [],
    compile: 'na',
    pre: [],
    reject: [],
    default: 'na',
    note: '手册示例程序。',
  },
  {
    path: ['TIA Portal Openness API', 'Use of the code examples'],
    api: [],
    compile: 'na',
    pre: [],
    reject: [],
    default: 'na',
    note: '示例使用说明（含免责声明）。',
  },

  // ------------------------------------------------------------ general functions
  {
    path: ['TIA Portal Openness API', 'General functions'],
    api: ['Siemens.Engineering'],
    compile: 'yes',
    pre: ['D', 'E'],
    reject: [],
    default: 'none',
    note:
      '通用机制：连接/断开、独占访问、事务、诊断、事件、对象模型辅助。' +
      '插件实现了连接、断开、独占访问、事务与诊断；事件回调、系统对话框确认、对象模型辅助函数未适配。',
    leaves: {
      'Connecting to the TIA Portal': { status: 'done', note: '已实现：TiaPortal 实例创建与附加运行中实例。' },
      'Terminating the connection to the TIA Portal': { status: 'done', note: '已实现：close_project(close_portal) 与控制器退出时释放。' },
      'Exclusive access': { status: 'done', note: '已实现：写操作包在 ExclusiveAccess 内，事务化提交。' },
      'Transaction handling': { status: 'done', note: '已实现：导入走单个事务，失败整体回滚。' },
      'Diagnostic interfaces on TIA Portal': {
        status: 'partial',
        note: '部分：自有诊断日志 + controller_status；未接 Openness 自身的诊断/Notification 接口。',
      },
      'Read operations for attributes': {
        status: 'partial',
        note: '部分：只读属性枚举 + EngineeringAttributeInfo（OpennessHost.cs:649-660），无通用属性读取工具。',
      },
      'Self-description support for attributes, navigators, actions, and services': {
        status: 'partial',
        note: '部分：用到 GetAttributeInfos()；navigators / actions / services 的自描述未使用。',
      },
      'Creating a DirectoryInfo/FileInfo object': {
        status: 'partial',
        note: '部分：导出/导入路径处理使用 .NET 文件 API，但未按手册该条封装的 Openness 辅助方式。',
      },
      'TIA Portal Openness firewall': {
        status: 'none',
        pre: ['W'],
        note:
          '未适配：插件不调用 IsAppWhitelisted / WhitelistApp。本机注册表已有 TiaOpennessV17Min.Controller.exe 条目；' +
          '自启无界面实例不触发提示，只有附加运行中实例才会。',
      },
      'Event handlers': { status: 'none', pre: ['D'], note: '未适配：未订阅 Openness 事件。' },
      'Program-controlled acknowledgement of dialogs with system events': {
        status: 'none',
        pre: ['D'],
        note: '未适配：无界面模式下靠不触发对话框规避，而非程序化确认。这是潜在风险点（例如独占访问对话框、系统错误框）。',
      },
      'Dynamic behaviours': { status: 'none', note: '未适配：未使用属性的动态行为/动态值语义。' },
      'Working with associations': { status: 'none', note: '未适配：未使用关联（association）语义。' },
      'Working with compositions': { status: 'none', note: '未适配：直接遍历组合（Composition），未使用手册的组合操作模式。' },
      'Verifying object equality': { status: 'none', note: '未适配：对象相等性判断未使用（按名称/路径比较）。' },
      'TIA Portal Openness IntelliSense support': { status: 'na', note: '开发期文档/IntelliSense 说明，非运行期能力。' },
    },
  },

  // ------------------------------------------------------------ projects
  {
    path: ['TIA Portal Openness API', 'Functions for projects and project data'],
    api: ['Siemens.Engineering', 'Siemens.Engineering.Compiler', 'Siemens.Engineering.Settings'],
    compile: 'yes',
    pre: ['E'],
    reject: ['R11'],
    default: 'none',
    note:
      '工程生命周期与工程级数据。创建、打开、保存（含另存）、归档/取回、关闭，以及工程属性、语言、多语言文本、' +
      '历史、已用产品与 TIA Portal 设置都已接入（OperationsProject.cs）；只读打开、图形删除未适配。',
    leaves: {
      'Opening a project': {
        status: 'done',
        note: '已实现：open_project，含 .ap17 校验、allow_upgrade 显式开关、dry_run。只读打开另见 "Accessing read-only TIA Portal project"。',
      },
      'Creating a project': {
        status: 'done',
        note: '已实现：create_project（ProjectComposition.Create；带 Author/Comment 时走 IEngineeringComposition.Create 的创建参数重载）。',
      },
      'Accessing general settings of the TIA Portal': {
        status: 'partial',
        note:
          '部分：portal_settings 读写 TiaPortal.SettingsFolders（General 等），value_type 支持 bool/string/int/CultureInfo，' +
          '并递归列出子文件夹；只覆盖标量设置。命名空间 Siemens.Engineering.Settings。',
      },
      'Archiving and Retrieving a project': {
        status: 'done',
        reject: ['R11'],
        note:
          '已实现：archive_project 的 archive/retrieve。有未保存改动时先报 project_not_saved（手册要求先 Save），' +
          'retrieve 支持 Retrieve 与 RetrieveWithUpgrade 以及 ProjectOpenMode.Primary/Secondary。',
      },
      'Accessing read-only TIA Portal project': {
        status: 'none',
        note: '未适配：没有 OpenMode.ReadOnly 打开路径，也没有 UMAC 凭据回调（UmacDelegate 一律传 null）。',
      },
      'Accessing languages': {
        status: 'done',
        note: '已实现：project_languages 的 list/set（LanguageSettings.Languages/ActiveLanguages 增删、EditingLanguage、ReferenceLanguage）。',
      },
      'Determining the object structure and attributes': {
        status: 'partial',
        note:
          '部分：project_info 的 devices 段在 include_attribute_infos=true 时给出每个设备/设备项的 GetAttributeInfos 与 ' +
          'GetCompositionInfos；不是"任意 IEngineeringObject"的通用对象树。',
      },
      'Access software target': {
        status: 'partial',
        note: '部分：software 段列出 PLC 软件目标（设备名/软件名/块数）；HMI 等其他目标仍未处理。',
      },
      'Accessing and enumerating multilingual texts': {
        status: 'partial',
        reject: ['R4'],
        note:
          '部分：project_info 的 comment 段枚举工程注释，update_project 写 editing language 的注释，project_texts 导出/导入整工程 ' +
          '文本（xlsx）。多语言文本不能单独导出（R4）。注意 ProjectText Import/Export 属手册 "Transaction handling → Restrictions" ' +
          '里事务内禁止的动作，所以 project_texts 不包事务。',
      },
      'Updating project property simulation support': {
        status: 'done',
        note: '已实现：update_project 的 simulation_during_block_compilation（Project.IsSimulationDuringBlockCompilationEnabled）。',
      },
      'Read project related attributes': {
        status: 'done',
        note:
          '已实现：project_info 的 attributes / history / products 三段（Author、Copyright、Family、Version、Size、CreationTime、' +
          'LastModified、LastModifiedBy、HistoryEntries、UsedProducts）。',
      },
      'Deleting project graphics': {
        status: 'none',
        note:
          '未适配：Project.Graphics 的类型是 Siemens.Engineering.Hmi.Globalization.MultiLingualGraphicComposition，' +
          '引入它就要把 HMI 命名空间纳入本插件；该操作不可逆，因此有意跳过。',
      },
      'Compiling a project': {
        status: 'partial',
        note:
          '部分：compile_plc 走 PLC 软件级 ICompilable（含 CompilerResult 逐条消息）；手册支持的 Device、DeviceItem、' +
          'CodeBlock、HmiTarget 等编译入口未暴露。',
      },
      'Saving a project': {
        status: 'done',
        note:
          '已实现：save_project 的 Save 与 SaveAs(save_as_dir)。两条 Openness 语义写进了工具描述：' +
          '(1) SaveAs 会**搬迁当前打开工程的持久化位置**（手册：Archive 不改持久化位置，SaveAs 会改，之后 close(save=true) 写新位置）；' +
          '(2) 无法给工程改名——Project.Name/Path 只读、且没有 SaveAs(folder,newName) 重载，只有 SaveAs(DirectoryInfo)，' +
          '目录之下怎么组织由 TIA 决定。手册从未写"目录名必须等于工程名"，插件因此不做这种校验，' +
          '而是回报 requestedSaveAsDir / savedAs / projectPath / locationChanged 让调用方核对落点。',
      },
      'Closing a project': { status: 'done', note: '已实现：close_project，可先保存、可关掉 TIA Portal 实例。' },
    },
  },
  {
    path: ['TIA Portal Openness API', 'Functions for Connections'],
    api: ['Siemens.Engineering.Connection'],
    compile: 'yes',
    pre: [],
    reject: [],
    default: 'none',
    note: '端口到端口连接的属性；插件的导入导出不处理连接对象。',
  },

  // ------------------------------------------------------------ libraries
  {
    path: ['TIA Portal Openness API', 'Functions on libraries'],
    api: ['Siemens.Engineering.Library', 'Siemens.Engineering.Library.Types', 'Siemens.Engineering.Library.MasterCopies'],
    compile: 'yes',
    pre: [],
    reject: ['R2', 'R8'],
    default: 'none',
    note: '全局库/项目库、类型版本、主副本。控制器完全没有引用这三个命名空间（0/47 类型）。',
  },

  // ------------------------------------------------------------ hardware & networks
  {
    path: ['TIA Portal Openness API', 'Functions for accessing devices, networks and connections'],
    api: ['Siemens.Engineering.HW', 'Siemens.Engineering.HW.Features'],
    compile: 'yes',
    pre: ['D'],
    reject: [],
    default: 'none',
    note: '设备/网络总入口。插件只用了其中"遍历设备并取软件容器"的一小块。',
    leaves: {
      'Querying PLC and HMI targets': { status: 'partial', note: '部分：只查询 PLC 目标（PlcSoftware），HMI 目标未处理。' },
      'Open the "Devices & networks" editor': { status: 'none', pre: ['D'], note: '未适配：属界面行为。' },
      'Accessing attributes of an address object': { status: 'none', reject: ['R6'], note: '未适配；且压缩地址与改址重连在 Openness 中本就受限。' },
      'Accessing the channels of a module': { status: 'none', note: '未适配。' },
    },
  },
  {
    path: ['TIA Portal Openness API', 'Functions on networks'],
    api: ['Siemens.Engineering.HW'],
    compile: 'yes',
    pre: [],
    reject: [],
    default: 'none',
    note: '子网、节点、IO 系统、端口互联、DP 主站系统等，全部未适配（硬件组态写属另一量级工程）。',
  },
  {
    path: ['TIA Portal Openness API', 'Functions on devices'],
    api: ['Siemens.Engineering.HW'],
    compile: 'yes',
    pre: [],
    reject: [],
    default: 'none',
    note: '设备的枚举/访问已适配；创建、删除、App ID、类型标识符未适配。',
    leaves: {
      'Enumerating devices': { status: 'done', note: '已实现：遍历 project.Devices。' },
      'Accessing devices': { status: 'done', note: '已实现：取 Device 及其组。' },
      'Mandatory attributes of devices': { status: 'partial', note: '部分：只读少量属性用于定位 PLC 软件。' },
      'Get type identifier of devices and device items': { status: 'none', note: '未适配。' },
      'Set App ID on device and device Items': { status: 'none', note: '未适配。' },
      'Get App ID on device and device Items': { status: 'none', note: '未适配。' },
      'Remove App ID on device and device items': { status: 'none', note: '未适配。' },
      'Creating a device': { status: 'none', note: '未适配。' },
      'Deleting a device': { status: 'none', note: '未适配。' },
    },
  },
  {
    path: ['TIA Portal Openness API', 'Functions on device items'],
    api: ['Siemens.Engineering.HW', 'Siemens.Engineering.HW.Features'],
    compile: 'yes',
    pre: [],
    reject: ['R10'],
    default: 'none',
    note: '设备项遍历与软件容器取值已适配；插拔/移动/复制/删除、地址、通道、psc 未适配。',
    leaves: {
      'Enumerate device items': { status: 'done', note: '已实现：递归遍历设备项。' },
      'Accessing device items': { status: 'done', note: '已实现：DeviceItem 访问。' },
      'Accessing device item as interface': { status: 'partial', note: '部分：只通过 GetService<SoftwareContainer>() 取软件，未做接口属性读取。' },
      'Mandatory attributes of device items': { status: 'partial', note: '部分：只读定位所需属性。' },
      'Creating and plugging a device item': { status: 'none', note: '未适配。' },
      'Moving device items into another slot': { status: 'none', note: '未适配。' },
      'Copying a device item': { status: 'none', note: '未适配。' },
      'Deleting a device item': { status: 'none', note: '未适配。' },
      'Accessing attributes of an I/O device interface': { status: 'none', note: '未适配。' },
      'Accessing attributes of IoController': { status: 'none', note: '未适配。' },
      'Accessing attributes of IoConnector': { status: 'none', note: '未适配。' },
      'Accessing address controller': { status: 'none', note: '未适配。' },
      'Accessing addresses': { status: 'none', note: '未适配。' },
      'Accessing hardware identifiers': { status: 'none', note: '未适配。' },
      'Accessing hardware identifier controller': { status: 'none', note: '未适配。' },
      'Accessing channels of device items': { status: 'none', note: '未适配。' },
      'Creating and exporting psc file': { status: 'none', reject: ['R10'], note: '未适配；且 .psc 不能分步创建+打开。' },
      'Connection handling for extension racks': { status: 'none', note: '未适配。' },
    },
  },

  // ------------------------------------------------------------ HMI
  {
    path: ['TIA Portal Openness API', 'Functions for accessing the data of an HMI device'],
    api: [
      'Siemens.Engineering.Hmi',
      'Siemens.Engineering.Hmi.Screen',
      'Siemens.Engineering.Hmi.Tag',
      'Siemens.Engineering.Hmi.Alarm',
      'Siemens.Engineering.Hmi.Cycle',
      'Siemens.Engineering.Hmi.Recipe',
      'Siemens.Engineering.Hmi.Report',
      'Siemens.Engineering.Hmi.Logging',
      'Siemens.Engineering.Hmi.RuntimeScripting',
      'Siemens.Engineering.Hmi.Faceplate',
      'Siemens.Engineering.Hmi.Communication',
      'Siemens.Engineering.Hmi.Globalization',
      'Siemens.Engineering.Hmi.MenuToolbar',
      'Siemens.Engineering.Hmi.TextGraphicList',
    ],
    compile: 'yes',
    pre: ['D'],
    reject: ['R3', 'R9'],
    default: 'none',
    note: 'HMI（WinCC）数据面：画面、模板、周期、文本/图形列表、连接、标签、VB 脚本。控制器对 Hmi.* 命名空间 0 引用。',
  },

  // ------------------------------------------------------------ PLC
  {
    path: ['TIA Portal Openness API', 'Functions for accessing the data of a PLC device'],
    api: [
      'Siemens.Engineering.SW',
      'Siemens.Engineering.Connection',
      'Siemens.Engineering.SW.Blocks',
      'Siemens.Engineering.SW.Blocks.Interface',
      'Siemens.Engineering.SW.Tags',
      'Siemens.Engineering.SW.Types',
      'Siemens.Engineering.SW.ExternalSources',
      'Siemens.Engineering.SW.Units',
      'Siemens.Engineering.SW.WatchAndForceTables',
      'Siemens.Engineering.SW.OpcUa',
      'Siemens.Engineering.SW.Alarm',
      'Siemens.Engineering.SW.Supervision',
      'Siemens.Engineering.SW.TechnologicalObjects',
      'Siemens.Engineering.Download',
      'Siemens.Engineering.Download.Configurations',
      'Siemens.Engineering.Upload',
      'Siemens.Engineering.Online',
      'Siemens.Engineering.Compare',
      'Siemens.Engineering.FingerprintData',
      'Siemens.Engineering.Safety',
      'Siemens.Engineering.Security',
      'Siemens.Engineering.MC.Drives',
      'Siemens.Engineering.MC.Drives.DFI',
      'Siemens.Engineering.MC.DriveConfiguration',
    ],
    compile: 'yes',
    pre: ['P'],
    reject: ['R1', 'R5', 'R6', 'R13', 'R14'],
    default: 'none',
    note:
      '插件的核心领域，也是手册里最大的章节。块/类型/标签表/外部源/编译这条链之外，已补上块与组的删除、know-how 保护、' +
      'OB 属性写、指纹读取、由块生成源、监视表、软件单元与 F 相关服务（OperationsPlc.cs / OperationsSafety.cs）；' +
      '下载/上传/在线/在线比较合成「在线与下载」主题（见文件末尾 SCOPES），目前整条主线未适配；' +
      '保护密码、OPC UA、力表建档同样未适配。',
    leaves: {
      // -- blocks
      Blocks: { status: 'done', note: '已实现：PlcBlockSystemGroup 遍历、单块增删改（list/create/delete/set_block_attributes）。' },
      'Querying the "Program blocks" group': { status: 'done', note: '已实现：software.BlockGroup，并可按 group_path 定位用户组。' },
      'Querying the system group for system blocks': { status: 'partial', note: '部分：遍历时区分系统组，但不操作系统块。' },
      'Enumerating system subgroups': { status: 'partial', note: '部分：只作为遍历路径处理。' },
      'Enumerating user-defined block groups': {
        status: 'done',
        note: '已实现：递归收集用户组路径（list_plc_objects 的 blockGroups），create_plc_objects(kind=block_group) 可建组。',
      },
      'Enumerating all blocks': { status: 'done', note: '已实现：递归枚举块（名称+组路径+语言+编号+时间戳）。' },
      'Querying information of a block/user data type': {
        status: 'done',
        note: '部分→已完成：list_plc_objects 回报编号、语言、IsConsistent、IsKnowHowProtected、AutoNumber、Header*、多个时间戳。',
      },
      'Setting and removing protections from a block': {
        status: 'done',
        note:
          '已实现：protect_blocks（PlcBlockProtectionProvider.Protect/Unprotect，先查 GetInvalidPasswordCharacters；' +
          'provider 为 null 时报 protection_unavailable，对应手册列出的可保护条件）。',
      },
      'Deleting block': { status: 'done', note: '已实现：delete_plc_objects 的 block_names（PlcBlock.Delete，事务内）。' },
      'Accessing attributes of all blocks': {
        status: 'done',
        note: '已实现：list_plc_objects(include_attributes=true) 用 GetAttributeInfos 列出每个块的全部属性名、访问模式与当前值。',
      },
      'Creating group for blocks': { status: 'done', note: '已实现：导入时 create_group 与 create_plc_objects(kind=block_group)。' },
      'Deleting group for blocks': { status: 'done', note: '已实现：delete_plc_objects 的 block_group_paths（非空组报 group_not_empty）。' },
      'Creating a ProDiag-FB': { status: 'none', reject: ['R14'], note: '未适配。' },
      'Accessing supervisions and properties of ProDiag-FB': { status: 'none', reject: ['R14'], note: '未适配。' },
      'Reading ProDiag-FB blocks and attributes': { status: 'none', reject: ['R14'], note: '未适配；工程实测 ProDiag 块也无法导出。' },
      'Adding an external file': { status: 'done', reject: ['R5'], note: '已实现：外部源文件导入（*.scl/*.stl/*.db/*.udt）；组层级不可访问。' },
      'Generate source from block': {
        status: 'done',
        note:
          '已实现：generate_source 经 PlcExternalSourceSystemGroup.GenerateSource（IGenerateSource），按手册校验扩展名 ' +
          '(.scl/.awl/.db/.udt) 与 GenerateOptions.WithDependencies。',
      },
      'Generating blocks from source': { status: 'done', note: '已实现：从外部源生成块，支持 GenerateBlockOption.KeepOnError。' },
      'Generating from source of known source format': { status: 'done', note: '已实现：SCL/STL/DB/UDT 源文件生成。' },
      'Deleting user data type': { status: 'done', note: '已实现：delete_plc_objects 的 type_names（PlcType.Delete）。' },
      'Deleting an external file': { status: 'done', note: '已实现：keep_source=false 时生成完删除外部源。' },
      'Starting the block editor': { status: 'none', pre: ['D'], note: '未适配：属界面行为。' },
      'Changing blocks using fingerprints': {
        status: 'done',
        note:
          '已完成：list_plc_objects(include_fingerprints=true, block_names/type_names=…) 逐块/逐 UDT 调 ' +
          'FingerprintProvider.GetFingerprints()，回报 {id, value}（Code/Comments/Interface/LibraryType/Texts/…）；' +
          'SyncScan 把整棵块/类型树的指纹与上一版 evidence 账本逐对象比对，并额外记录 F 块的 SafetySignatureProvider 签名，' +
          '只导出差异对象，比较在控制器内部完成，不经过 1000 条列表上限。' +
          '手册这一条只有读接口——"检测变化"靠调用方比对两次取到的 value，Openness 没有写入/改写指纹的 API；' +
          '标签表按手册不支持指纹。',
      },
      'Generating/deleting blocks for user defined pages': { status: 'none', note: '未适配。' },
      'Writing access for OB block priority attribute': {
        status: 'done',
        note: '已实现：set_block_attributes 的 attributes（通用 SetAttribute，手册示例即 SetAttribute("Priority", 14)）。',
      },
      'Generating block/UDT from external source file in specific user group': {
        status: 'done',
        note: '已实现：target_group / mirror_groups 控制生成位置。',
      },
      // -- tags
      'Tags and Tag tables': {
        status: 'done',
        note: '已完成：枚举、导出、导入、建表、删表、建/删组、单标签与用户常量的增改删（write_tags / delete_plc_objects）。',
      },
      'Querying system groups for PLC tags': { status: 'done', note: '已实现：PlcTagTableSystemGroup 遍历。' },
      'Enumerating user-defined groups for PLC tags': { status: 'done', note: '已实现：递归收集标签表用户组路径。' },
      'Creating user-defined groups for PLC tags': { status: 'done', note: '已实现：导入时按需创建；create_plc_objects(kind=tag_table_group)。' },
      'Enumerating PLC tag tables in a folder': { status: 'done', note: '已实现：PlcTagTable 枚举（含组路径、IsDefault、标签数）。' },
      'Querying information from a PLC tag table': {
        status: 'done',
        note: '已完成：名称、所属组、标签数、IsDefault、ModifiedTimeStamp（见下一条）。',
      },
      'Enumerating PLC tags': {
        status: 'done',
        note: '已实现：list_plc_objects(include_tags=true) 逐标签给出 Name/DataType/LogicalAddress/Comment/External* 三个开关。',
      },
      'Accessing PLC tags': {
        status: 'done',
        note:
          '已完成：读（list_plc_objects）与写（write_tags 改 DataTypeName、LogicalAddress、External* 与注释，并按需创建/删除）。' +
          'Name 只读（手册明示），改名不支持。',
      },
      'Starting the "PLC Tags" editor': { status: 'none', pre: ['D'], note: '未适配：属界面行为。' },
      'Creating PLC tag table': { status: 'done', note: '已实现：create_plc_objects(kind=tag_table)（PlcTagTableComposition.Create）。' },
      'Deleting user-defined groups for PLC tags': { status: 'done', note: '已实现：delete_plc_objects 的 tag_table_group_paths。' },
      'Reading the time of the last changes of a PLC tag table': {
        status: 'done',
        note:
          '已完成，并纠正旧结论：V17 的 PlcTagTable 暴露 ModifiedTimeStamp（不是 ModifiedDate），' +
          'list_plc_objects 的 tagTables[].modifiedTimeStamp 即它。',
      },
      'Deleting a PLC tag table from a group': { status: 'done', note: '已实现：delete_plc_objects 的 tag_table_names（PlcTagTable.Delete）。' },
      'Accessing PLC constants': {
        status: 'done',
        note:
          '已完成：list_plc_objects(include_constants=true) 列用户常量与系统常量；write_tags 可建/改/删用户常量' +
          '（Name、DataTypeName、Value、Comment）；系统常量只读（手册明示）。',
      },
      // -- software units
      'Functions for software units': {
        status: 'partial',
        note: '部分：software_units 覆盖列表/创建/删除/关系增删（PlcUnitProvider 经 GetService 获取）。',
      },
      'Working with software unit': { status: 'partial', note: '部分：建/删/列举已实现；发布与"作为主副本"未做。' },
      'Accessing software unit': { status: 'done', note: '已实现：PlcUnit 的 Name/Author/Comment 与关系列表。' },
      'Accessing software unit underlying objects': {
        status: 'partial',
        note: '部分：只回报单元下块/类型/标签表/外部源的数量，不逐个列出对象。',
      },
      'Accessing to existing relations of a unit': { status: 'done', note: '已实现：PlcUnit.Relations 的 RelatedObject + RelationType。' },
      'Updating software unit properties': { status: 'partial', note: '部分：Author/Comment 只读回报，未写回。' },
      'Publishing software unit object': { status: 'none', note: '未适配（UnitAccessType.Published 存在但未暴露）。' },
      'Adding external sources in units': { status: 'none', note: '未适配：外部源只走非单元路径。' },
      'Units as mastercopies': { status: 'none', note: '未适配（库/主副本整体未适配）。' },
      'Updating existing relations & create/delete relations': {
        status: 'done',
        note: '已实现：software_units 的 relation_create / relation_delete（PlcUnitRelationComposition.Create/Find + PlcUnitRelation.Delete）。',
      },
      // -- online / download / upload
      //
      // 手册把它们放在 PLC 数据章节里，但 API 面其实由 Siemens.Engineering
      // 的 .Connection / .Online / .Download / .Upload / .Compare 五个命名空间承载。
      // 这一组同时是文件末尾 SCOPES 里「在线与下载」主题的成员，条目名必须与
      // 手册 TOC 标题逐字一致（主题解析不到就会构建失败）。
      'Determining the status of a PLC': {
        status: 'none',
        pre: ['P'],
        note:
          '未适配：在线状态读 OnlineProvider.State（OnlineState 七个值：Connecting / Disconnecting / Incompatible / ' +
          'NotReachable / Offline / Online / Protected）；provider 从 CPU 设备项（DeviceItemClassifications.CPU）' +
          'GetService 取，需可达设备（P）。',
      },
      'Accessing parameters of an online connection': {
        status: 'none',
        pre: ['P'],
        note:
          '未适配：连接编址在 Siemens.Engineering.Connection（ConfigurationAddress.Address/Name、ConfigurationSubnet、' +
          'ConfigurationGateway）；入口是 provider.Configuration（ConnectionConfiguration）与 ConfigurationTargetInterface.Addresses，' +
          '需可达设备（P）。',
      },
      'Accessing fingerprint for quick station compare': {
        status: 'none',
        pre: ['P'],
        note:
          '未适配，且与"Changing blocks using fingerprints"是**两套 API**：这一条走 ' +
          'Siemens.Engineering.FingerprintData.FingerprintDataProvider（从 TiaPortal.GetService 取），' +
          'GetFingerprintData(ConfigurationAddress, OnlineConfigurationDelegate) 需要 PN/IE 接口 + 设备 IP，' +
          '即必须有可达的真实设备（手册写 "PLC is offline" 但地址是连设备用的），纯离线工程无法验证。',
      },
      'Accessing CM DP as DP slave and transfer area': {
        status: 'none',
        pre: ['P'],
        note: '未适配：属 DP 组态/传输区（DpOperatingMode 等硬件面），不在在线会话的调用链上，未列入「在线与下载」主题。',
      },
      'Setting PLC online of R/H system': {
        status: 'none',
        pre: ['P'],
        note:
          '未适配：冗余站走 RHOnlineProvider 的 GoOnlineToPrimary / GoOnlineToBackup / GoOffline，' +
          '状态分 PrimaryState / BackupState；需冗余 PLC（P）。2026-10-24 口径：R/H 站不在「在线与下载」主题内，暂不实现。',
      },
      'Accessing software container from primary PLC of R/H system': {
        status: 'none',
        pre: ['P'],
        note:
          '未适配：冗余主站的软件容器访问，与 RHOnlineProvider 的 PrimaryState 同一条路径；需冗余 PLC（P）。' +
          '2026-10-24 口径：R/H 站不在「在线与下载」主题内，暂不实现。',
      },
      'Downloading PLCs of R/H System': {
        status: 'none',
        pre: ['P'],
        note:
          '未适配：RHDownloadProvider.DownloadToPrimary / DownloadToBackup，参数与 DownloadProvider.Download 相同' +
          '（多一个 ConfigurationAddress 重载）；需冗余 PLC（P）。2026-10-24 口径：R/H 站不在「在线与下载」主题内，暂不实现。',
      },
      'Functions for downloading data to PLC device': {
        status: 'none',
        pre: ['P'],
        note:
          '未适配（手册的分组条目，本身不是 API）：下载的具名动作在下面几条。本主题只收 PLC 侧 —— ' +
          'Downloading hardware and software components / Running and stopping PLC / Supporting callbacks；' +
          'PC System 与 R/H 已排除。',
      },
      'Downloading PC System': {
        status: 'none',
        pre: ['P'],
        note:
          '未适配：PC 站（WinCC 等）下载，与 PLC 下载共用 DownloadProvider，差别在目标站类别与 DownloadOptions；' +
          '需可达设备（P）。2026-10-24 口径：PC System 不在「在线与下载」主题内，暂不实现。',
      },
      'Downloading hardware and software components to PLC device': {
        status: 'partial',
        pre: ['P'],
        reject: ['R16'],
        note:
          '已接线未实测：download 操作走 DownloadProvider.Download(IConfiguration, 双回调, DownloadOptions)，' +
          'dry_run 默认只解析目标，confirm=true 才真下、kind=physical 还要 confirm_real_device=true；' +
          '回调按固定策略回答停机/密码/一致下载等配置，DownloadOptions 用 None / Hardware / Software 组合。' +
          'F 激活的 PLC 不支持该 API（R16）。2026-10-24 实测（V20 + PLCSIM Advanced V7 + TCP/IP）：根因是首次连接要接受 PLC 自签名证书，' +
          '这是 UI 决策、Openness 没有对应委托（TlsVerificationConfiguration 只挂在 FingerprintDataProvider 上），' +
          '所以自开工程的控制器一律在 connect 阶段失败且回调不触发；用 adopt 接管 UI 已信任的会话后连续两次下载成功（0 error）。' +
          'V17 控制器同路径未实测，故仍记部分。',
      },
      'Running and stopping PLC': {
        status: 'none',
        pre: ['P'],
        note:
          '未适配：Openness 没有独立的 Run/Stop API（PlcSoftware 只有 CompareTo / CompareToOnline）——' +
          'PLC 启停是下载配置里的选项：Download.Configurations 的 StartModules / StopModules / StartBackupModules / ' +
          'StopHSystem / TurnOffSequence / WaitOnReboot。',
      },
      'Uploading hardware, software and files to PLC device': {
        status: 'none',
        pre: ['P'],
        note:
          '未适配：StationUploadProvider.StationUpload(ConfigurationAddress, UploadConfigurationDelegate) 返回 UploadResult' +
          '（State / Messages / UploadedStation）；需可达设备（P）。',
      },
      'Comparing PLC software': {
        status: 'none',
        pre: ['P'],
        note: '未适配：PlcSoftware.CompareToOnline 返回 Siemens.Engineering.Compare.CompareResult（RootElement / ComparisonResult），需先在线（P）。',
      },
      'Comparing PLC hardware': {
        status: 'none',
        pre: ['P'],
        note: '未适配：设备级在线比较，与软件比较共用 Compare 命名空间；需在线（P）。',
      },
      'Establishing or disconnecting the online connection to the PLC': {
        status: 'done',
        pre: ['P'],
        note:
          '已验证（V17 + PLCSIM Advanced V7 TCP/IP，adopt UI 工程后）：online_connect 4.4 s 到 OnlineState.Online，' +
          'online_status 读回 Online，online_disconnect 回到 Offline；失败的 GoOnline 会补 GoOffline，避免 TIA 停在半在线。' +
          '首次连设备必须先在 TIA UI 接受自签名证书（Openness 无该委托，headless 必败），见 PROTOCOL 的 Certificate precondition。' +
          'V17 另有 SetPlcMasterSecret / ResetPlcMasterSecret 未接；真实 PLC 未验（P）。',
      },
      'Assigning PC interface': {
        status: 'done',
        pre: ['P'],
        note:
          '已验证（V17 + PLCSIM）：online_connect 用 pc_interface / pc_interface_number / target_interface 选中' +
          '「Siemens PLCSIM Virtual Ethernet Adapter → 1 X1」并成功上线；online_targets 把这些组合连同 kind（virtual/physical）' +
          '和子网地址一次列全，调用方据此选择。',
      },
      'Determining the status of a PLC': {
        status: 'done',
        pre: ['P'],
        note:
          '已验证（V17 + PLCSIM）：online_status 在读控制器会话时返回 state=Online / ok=true，断开后 connected=false；' +
          '值域是 OnlineState 七个值，读的是实时 State，不会触发连接。',
      },
      'Accessing parameters of an online connection': {
        status: 'partial',
        pre: ['P'],
        note:
          '已接线未实测：online_targets 枚举 Modes → PcInterfaces(Name/Number) → TargetInterfaces、' +
          'Subnets/Addresses/Gateways，并用 NetworkInterface.Nodes 的 Address / SubnetMask / ConnectedSubnet ' +
          '把工程内 PLC 的离线 IP 按网段分组，给出「哪个 PC 接口能到哪个网段」；不能设置/改写这些参数。',
      },
      'Supporting callbacks': {
        status: 'none',
        pre: ['P', 'D'],
        note:
          '未适配：V17 的交互面只有三个委托（DownloadConfigurationDelegate、UploadConfigurationDelegate、' +
          'OnlineConfigurationDelegate），下载时每个需要用户决策的步骤都以 Download.Configurations 下的类型回传；' +
          '不实现它们就只能走默认选择。',
      },
      // -- protection / security / misc
      'Protecting PLC through password': {
        status: 'none',
        note:
          '未适配：PLC 密码在下载期提供 —— Download.Configurations 的 PlcMasterSecretPassword / ModuleReadAccessPassword / ' +
          'ModuleWriteAccessPassword（均 SetPassword(SecureString)）；在线侧另有 OnlineProvider.SetPlcMasterSecret。' +
          '块级 know-how 保护已适配（见上），与这里不是同一套。',
      },
      'Handling PLC block binding passwords': {
        status: 'none',
        note:
          '未适配：下载回调用 Download.Configurations.BlockBindingPassword 收集块绑定密码；' +
          '手册单列是因为它既不是 PLC 主密钥也不是块 know-how 保护密码。',
      },
      'Access level setting': {
        status: 'none',
        note: '未适配：访问级别属保护设置属性面（与密码同章），不在在线/下载调用链上，未列入「在线与下载」主题。',
      },
      'Setting a display password': { status: 'none', note: '未适配。' },
      'Functions for accessing PLC service': {
        status: 'done',
        note:
          '已实现：PlcChecksum 经 PlcSoftware.GetService<PlcChecksumProvider>() 读编译后校验和；' +
          'V17 程序集的属性名是 Software（不是新手册里的 Checksum），为空表示未编译或改动后未再编译，' +
          '控制器以 checksum_unavailable 回报这个状态。',
      },
      'Accessing OPC UA server interface': { status: 'none', note: '未适配。' },
      'Accessing web server and OPC UA user management': { status: 'none', note: '未适配。' },
      'Accessing domain settings': { status: 'none', note: '未适配。' },
      'Managing certificate': { status: 'none', note: '未适配。' },
      'Assigning watch & force tables for web server and PLC display': {
        status: 'none',
        note: '未适配：本条是"给 Web 服务器/面板指定监视表"的属性，不是监视表本身的增删（后者见 watch_and_force_tables）。',
      },
      'Accessing Software Checksum': {
        status: 'done',
        note:
          '已实现：PlcChecksum（服务面 readPlcChecksum）读 PlcChecksumProvider.Software；' +
          'SyncScan 的快速路径在 checksum 与账本一致时直接返回 unchanged，不遍历指纹、不导出文件。',
      },
      'Assigning project language to PLC': { status: 'none', note: '未适配：工程语言已适配，PLC 侧语言未做。' },
      'Supporting IP Accessibility': { status: 'none', note: '未适配。' },
      'Updating module description': { status: 'none', note: '未适配。' },
    },
  },

  // ------------------------------------------------------------ VCI / multiuser / OPC / specials
  {
    path: ['TIA Portal Openness API', 'Functions for Version Control Interface'],
    api: ['Siemens.Engineering.VersionControl'],
    compile: 'yes',
    pre: ['P'],
    reject: [],
    default: 'none',
    note: 'VCI 用户组/工作区/映射/同步；控制器 0 引用。',
  },
  {
    path: ['TIA Portal Openness API', 'Functions support for Multiuser'],
    api: ['Siemens.Engineering.Multiuser'],
    compile: 'yes',
    pre: ['P'],
    reject: [],
    default: 'none',
    note: '多用户工程（项目服务器、本地会话、锁定状态、提交/丢弃）；控制器 0 引用。',
  },
  {
    path: ['TIA Portal Openness API', 'Functions on OPC'],
    api: ['Siemens.Engineering.SW.OpcUa', 'Siemens.Engineering.Security'],
    compile: 'yes',
    pre: ['P'],
    reject: [],
    default: 'none',
    note: 'OPC UA 安全通信协议与安全策略配置；未适配。',
  },
  {
    path: ['TIA Portal Openness API', 'Openness for CP 1604/CP 1616/CP 1626'],
    api: ['Siemens.Engineering.HW'],
    compile: 'yes',
    pre: ['P'],
    reject: [],
    default: 'none',
    note: '通信处理器专用对象；未适配（需真实硬件）。',
  },
  {
    path: ['TIA Portal Openness API', 'Openness transfer areas for PnPn coupler'],
    api: ['Siemens.Engineering.HW'],
    compile: 'yes',
    pre: ['P'],
    reject: [],
    default: 'none',
    note: 'PnPn 耦合器传输区；未适配。',
  },
  {
    path: ['TIA Portal Openness API', 'Openness virtual modules/submodules for ET 200SP PN HF'],
    api: ['Siemens.Engineering.HW'],
    compile: 'yes',
    pre: ['P'],
    reject: [],
    default: 'none',
    note: 'ET 200SP PN HF 虚拟模块/子模块；未适配。',
  },
  {
    path: ['TIA Portal Openness API', 'Exceptions'],
    api: ['Siemens.Engineering'],
    compile: 'yes',
    pre: [],
    reject: [],
    default: 'partial',
    note:
      'Openness 异常体系（EngineeringException、NonRecoverableException、LicenseNotFoundException 等）。' +
      '控制器把异常归一成稳定错误码（Protocol.cs 的 ControllerException + OpennessHost.Failure），不是按手册异常类型分类。',
    leaves: {
      'Handling exceptions': {
        status: 'partial',
        note: '部分：异常→错误码映射（access denied / licence / group 等提示已实现），未逐类型对应手册的异常清单。',
      },
    },
  },
  {
    path: ['TIA Portal Openness API', 'F-related Openness'],
    api: ['Siemens.Engineering.Safety'],
    compile: 'yes',
    pre: ['P'],
    reject: ['R1', 'R16'],
    default: 'none',
    note:
      'F 相关：safety_status 读 GlobalSettings（取自 TiaPortal.GetService）、SafetyAdministration.Settings 与运行时组；' +
      'set_safety_settings 写手册只有的两个动作；safety_signatures 逐块读 SafetySignatureProvider；' +
      'SyncScan 把 F 签名写进 evidence 账本并参与变化判定（F-OB 导不出来，签名是它唯一的变更证据）。' +
      '注意 F 块本身可以导入导出（见限制 R1），只有 F-system 块不行；整个 F 程序不能经 Openness 下载（见限制 R16）。',
    leaves: {
      'F-related Openness': {
        status: 'partial',
        pre: ['P'],
        note:
          '部分：三个服务都已接入（GlobalSettings、SafetyAdministration/SafetySettings/SafetyPrintout 未做的只有打印，' +
          'SafetySignatureProvider）。实机验证：SWT2_PEI_FJib_Hold 是带 F 程序的工程（55 个 F 块，含拒绝导出的 FOB_SAFETY），' +
          'safety_signatures 与 SyncScan 均已跑通；未做的只剩打印类接口。',
      },
      SafetyModificationsPossible: {
        status: 'done',
        pre: [],
        note:
          '已实现：set_safety_settings 的 safety_modifications_possible（读/写成对回报 before/after）；' +
          'safety_status 读当前值。GlobalSettings 经 TiaPortal.GetService 获取（手册 "F-related Openness"）。',
      },
      UsernameForFChangeHistory: {
        status: 'done',
        pre: [],
        note: '已实现：set_safety_settings 的 username_for_f_change_history（读/写成对回报 before/after）。',
      },
      SafetySignatureProvider: {
        status: 'done',
        pre: ['P'],
        note:
          '已实现并有实机数据：safety_signatures 逐块 GetService<SafetySignatureProvider>()，Find(BlockOfflineSignature) 后回报 Type/Value；' +
          'provider 为 null 即非 F 块（手册明示），按"没有签名"回报而不是报错；签名缺失/失效回报 0。' +
          'SyncScan 也把签名写进 evidence 账本（isSafetyBlock + safetySignature），并用"编程语言 F_* 或 OB"预筛后再问 provider；' +
          '实测 SWT2_PEI_FJib_Hold：1155 块里 55 个 F 块（54 个 F_* 语言 + 1 个 SCL 的 FOB_SAFETY），预筛 0 误判。',
      },
    },
  },

  // ------------------------------------------------------------ export / import
  {
    path: ['Export/import', 'Overview'],
    api: [],
    compile: 'yes',
    pre: [],
    reject: ['R7'],
    default: 'none',
    note: '导入导出总则与 Simatic ML 版本规则。插件只解析 ML 头与元素类型，未实现版本特定导入。',
    leaves: {
      'Basic principles of importing/exporting': {
        status: 'partial',
        reject: ['R7'],
        note: '部分：同子树对象进出正常；跨子树引用只能以 open reference 进出（R7）——这正是导入必须回原用户组的原因之一。',
      },
      'Version Specific Simatic ML Import': { status: 'none', note: '未适配：没有按 ML 版本分支处理（SimaticMl.cs 只在注释里提到 version="V17"）。' },
      'Field of application for Import/Export': { status: 'na', note: '适用范围说明，非能力。' },
      'Editing the XML file': { status: 'na', note: '编辑 XML 的操作指南，非 API 能力。' },
      'Exporting configuration data': { status: 'partial', reject: ['R2'], note: '部分：块/类型/标签表可导出；库中的对象类型不可导出（R2）。' },
      'Importing configuration data': { status: 'partial', note: '部分：块/类型/标签表可导入，结构化错误（含代码错误）会整体回滚。' },
    },
  },
  {
    path: ['Export/import', 'Import/export of project data'],
    api: ['Siemens.Engineering'],
    compile: 'yes',
    pre: [],
    reject: ['R4'],
    default: 'none',
    note: '工程图形与工程文本的导入导出；未适配（多语言文本另受 R4 限制）。',
  },
  {
    path: ['Export/import', 'Importing/exporting data of an HMI device'],
    api: [
      'Siemens.Engineering.Hmi.Screen',
      'Siemens.Engineering.Hmi.Tag',
      'Siemens.Engineering.Hmi.Cycle',
      'Siemens.Engineering.Hmi.RuntimeScripting',
      'Siemens.Engineering.Hmi.TextGraphicList',
      'Siemens.Engineering.Hmi.Faceplate',
    ],
    compile: 'yes',
    pre: ['D'],
    reject: ['R3', 'R9'],
    default: 'none',
    note: 'HMI 侧导入导出（画面、模板、永久区域、弹出/滑入画面、文本/图形列表、连接、周期、标签、VB 脚本）；全部未适配。',
  },
  {
    path: ['Export/import', 'Export/Import Watch & Force Table'],
    api: ['Siemens.Engineering.SW.WatchAndForceTables'],
    compile: 'yes',
    pre: [],
    reject: ['R15'],
    default: 'none',
    note:
      '监视表/强制表的导入导出。watch_and_force_tables 覆盖导出（两者）、导入（两者）以及监视表的创建/删除；' +
      '力表不能创建也不能删除（R15）。',
    leaves: {
      'Export/Import Watch & Force Table': {
        status: 'partial',
        reject: ['R15'],
        note:
          '部分：export/import 两个 action 对监视表与力表都可用（监视表导入到组，力表只能靠导入建立）；' +
          '力表的 Create/Delete 在 V17 不存在（R15）。',
      },
    },
  },
  {
    path: ['Export/import', 'Importing/exporting data of a PLC device'],
    api: ['Siemens.Engineering.SW.Blocks', 'Siemens.Engineering.SW.Tags', 'Siemens.Engineering.SW.Types'],
    compile: 'yes',
    pre: [],
    reject: ['R1', 'R12'],
    default: 'none',
    note:
      '块/类型/标签表这条主线已打通，且三类对象都能从 DSH 工具指定（categories）；' +
      'DB 快照、know-how 保护、系统块、GRAPH 多语言、opc ua XML 未适配。',
    leaves: {
      Blocks: { status: 'partial', note: '部分：块 XML 读回校验与失败清单已实现，未做快照/保护块等变体。' },
      'XML structure of the block interface section': { status: 'partial', note: '部分：只解析块头与接口的一部分字段。' },
      'Importing block': { status: 'done', note: '已实现：import_blocks（Simatic ML），事务化 + 写后读回校验。' },
      'Exporting blocks': { status: 'done', note: '已实现：export_blocks，逐块容错 + manifest（SHA-256）。' },
      'Export/Import of SCL blocks': { status: 'done', note: '已实现：SCL 块的 XML 与外部源两条路径。' },
      'Export/Import of structured types of SCL blocks': { status: 'partial', note: '部分：结构化类型随块/UDT 进出，未单独建模。' },
      'Export/Import of SCL call blocks': { status: 'partial', note: '部分：调用块按普通块处理，未验证特殊语义。' },
      'Importing blocks/UDT with open reference': { status: 'partial', reject: ['R7'], note: '部分：已暴露 sw_import_options=ignore_missing_referenced_objects。' },
      'Importing blocks/UDT for structural change object': { status: 'partial', note: '部分：已暴露 sw_import_options=ignore_structural_changes。' },
      'Exporting failsafe blocks': {
        status: 'partial',
        reject: ['R1'],
        note: '部分：F 块可导出；F-system 块被 API 拒绝（工程实测 FOB_SAFETY）。',
      },
      'Changes of the object model and XML file format': { status: 'none', note: '未适配：没有格式变更分支。' },
      'Exporting DBs with snapshots': { status: 'none', note: '未适配。' },
      'Exporting blocks with know-how protection': { status: 'none', note: '未适配。' },
      'Exporting system blocks': { status: 'none', note: '未适配。' },
      'Exporting GRAPH blocks with multi-language text': { status: 'none', note: '未适配。' },
      'Export/Import of unit specific publishing attribute of blocks and types': { status: 'none', note: '未适配（软件单元相关）。' },
      'Creating Instance DB': { status: 'done', note: '已实现：create_plc_objects(kind=instance_db)（PlcBlockComposition.CreateInstanceDB）。' },
      'Accessing DB value parameter without export': { status: 'none', note: '未适配。' },
      'Tag tables': { status: 'partial', note: '部分：表级导出/导入已实现（categories=tag_tables）；单标签/常量的 XML 导入导出未做（可用 write_tags 直接建改）。' },
      'Exporting PLC tag tables': { status: 'done', note: '已实现：categories=tag_tables，落盘到 <output_dir>/tag_tables/。' },
      'Importing PLC tag table': { status: 'done', note: '已实现：按 XML 元素识别标签表并导入。' },
      'Exporting user data type': { status: 'done', note: '已实现：categories=types，落盘到 <output_dir>/types/。' },
      'Importing user data type': { status: 'done', note: '已实现：SW.Types.* 元素识别为 PLC 类型。' },
      'Exporting an individual tag or constant from a PLC tag table': { status: 'none', note: '未适配。' },
      'Importing an individual tag or constant into a PLC tag table': { status: 'none', note: '未适配。' },
      'Export of data in OPC UA XML format': { status: 'none', note: '未适配。' },
    },
  },
  {
    path: ['Export/import', 'Importing/exporting hardware data'],
    api: [
      'Siemens.Engineering.Cax',
      'Siemens.Engineering.HW.Utilities',
      'Siemens.Engineering.HW.CustomDataTypes',
      'Siemens.Engineering.HW.Extensions',
      'Siemens.Engineering.HW.Systemdiagnostics.Settings',
    ],
    compile: 'yes',
    pre: [],
    reject: ['R12', 'R13'],
    default: 'none',
    note: 'CAx/AML 硬件数据导入导出（设备、设备项、子模块、子网、IO 系统、拓扑、GSD/GSDML、F 设备等）；全部未适配。',
  },

  // ------------------------------------------------------------ version history
  {
    path: ['Major Changes'],
    api: [],
    compile: 'na',
    pre: [],
    reject: [],
    default: 'na',
    note:
      '版本变更说明（V16/V15.1/V15/V14 SP1/V14）。对本插件的影响是"导入旧版 Simatic ML 的行为差异"，' +
      '当前没有版本分支，属于未适配的隐性风险。',
  },
]

/**
 * Short names that word-boundary matching would attribute to an Openness type
 * even though the controller uses them for something else. Removing them keeps
 * the auto-computed coverage honest; `build-matrix.mjs` prints this list on the
 * page so the exclusions stay reviewable.
 */
/**
 * Short names that the per-file scan would still attribute to an Openness type
 * even though the controller uses them for something else. Removing them keeps
 * the auto-computed coverage honest; `build-matrix.mjs` lists this map on the
 * page and reports an entry as stale once it stops matching.
 *
 * The list is deliberately short: because matching is scoped by each file's
 * `using` directives and comments/strings are stripped first, identifiers that
 * merely *read* like Openness types (FB, FC, OB, GlobalDB, PlcStruct …) no
 * longer need to be listed here.
 */
export const AMBIGUOUS_NAMES = {
  Software: 'OpennessHost.cs 里的字段名 Software（其类型是 PlcSoftware），不是 Siemens.Engineering.HW.Software',
}

/**
 * Where the DSH tools stop exposing what the controller already implements.
 *
 * Currently empty: `categories` / `type_names` / `tag_table_names` reached the
 * tool schemas in commit ef367ed ("feat: export and import PLC types (UDTs) and
 * tag tables"), so the matrix no longer has to flag any "CLI-only" capability.
 *
 * Keep the shape when a new gap appears: `probe` is a string that only exists in
 * `src/tools.ts` once the gap is closed, so `build-matrix.mjs` can turn the
 * note into a build error instead of letting it go stale.
 */
export const TOOL_GAPS = []

/**
 * Capability themes (扩展主线): named subsets of the matrix, used to plan the
 * next implementation step and to filter the page by theme instead of keyword
 * (the matrix page renders them as "主题" checkboxes and `?scope=<id>` links).
 *
 * Every item is an exact (section, leaf title) pair — a title that no longer
 * exists under that section is a build error, so a manual update cannot shrink
 * a theme silently. Adding a theme costs one entry here; `build-matrix.mjs`
 * resolves the titles against the manual TOC snapshot and does the rest.
 */
export const SCOPES = [
  {
    id: 'online-download',
    label: '在线与下载',
    summary:
      'TIA 的在线会话（连接/断开、PC 接口、PLC 启停、在线比较）与 PLC 下载、上传合成的一条扩展主线。' +
      '公共底座是 Siemens.Engineering.Connection 的 IConfiguration + ConfigurationTargetInterface，' +
      '以及 Online/Download/Upload 三个 ConfigurationDelegate；在线比较另走 Compare 命名空间。' +
      '整条主线都需要可达的 PLC（前置条件 P）—— 本机用 PLCSIM Advanced 的虚拟实例承担该角色，' +
      '实例、虚拟网卡与 IP 由 PLCSIM 侧提供，TIA 侧只认"PC 接口 + 目标地址"。' +
      '按 2026-10-24 的口径，R/H（冗余）与 PC System 不在本主题内，见 excluded。',
    section: ['TIA Portal Openness API', 'Functions for accessing the data of a PLC device'],
    groups: [
      {
        label: '在线会话',
        titles: [
          'Establishing or disconnecting the online connection to the PLC',
          'Determining the status of a PLC',
          'Accessing parameters of an online connection',
          'Assigning PC interface',
          'Running and stopping PLC',
          'Accessing fingerprint for quick station compare',
        ],
      },
      {
        label: '下载',
        titles: ['Downloading hardware and software components to PLC device'],
      },
      {
        label: '上传',
        titles: ['Uploading hardware, software and files to PLC device'],
      },
      {
        label: '在线比较',
        titles: ['Comparing PLC software', 'Comparing PLC hardware'],
      },
      {
        label: '密码与回调',
        titles: ['Supporting callbacks', 'Protecting PLC through password', 'Handling PLC block binding passwords'],
      },
    ],
    excluded: [
      { title: 'Setting PLC online of R/H system', reason: '冗余（R/H）站在线，本主题只做单站 PLC' },
      {
        title: 'Accessing software container from primary PLC of R/H system',
        reason: '冗余主站软件容器，随 R/H 站一起排除',
      },
      { title: 'Downloading PLCs of R/H System', reason: '冗余站下载（RHDownloadProvider），同上' },
      { title: 'Downloading PC System', reason: 'PC 站（WinCC 等）下载，不是 PLC 下载' },
    ],
  },
]
