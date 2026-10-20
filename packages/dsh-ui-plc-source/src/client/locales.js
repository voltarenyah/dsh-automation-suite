/**
 * The tab's copy, in the two built-in locales.
 *
 * Registered through `ctx.locale.register(NS, { zh, en })`, which is what makes
 * the text follow the app's language setting: the slot renderer re-renders a
 * registration's component when the locale changes, so every string a component
 * asks for during render is current. Strings captured *outside* that path (a
 * registry value, a plain object) would keep the language they were built in —
 * which is why the tab type and its guide entry register thunks, and why nothing
 * here is read at registration time other than the thunk itself.
 *
 * Both locales must be complete: the typed namespace form the runtime expects
 * requires `zh` and `en` to carry the same key set, and `test/locales.test.mjs`
 * fails if they drift apart.
 *
 * @module dsh-ui-plc-source/locales
 */

/** Namespace every key here is registered under. */
export const NS = 'plcSource'

/** Keys interpolate `{name}` placeholders; see the call sites in Panel.jsx. */
export const zh = {
  'tab.title': 'PLC 块',
  'guide.title': 'PLC 块',
  'guide.description': 'source/ 下的 PLC 源文件，可按 device 与类型筛选',

  'action.refresh': '刷新',
  'action.refreshing': '读取中…',
  'action.clear': '清除',

  'filter.device.all': '全部 device（{count}）',
  'filter.device.label': '按 device 筛选',
  'filter.type.all': '全部类型（{count}）',
  'filter.type.label': '按类型筛选',

  'search.placeholder': '搜索名称或编号',
  'search.label': '按名称或编号搜索',

  'hint.noWorkspace': '这个会话没有工作区目录，无法定位 source/。',
  'hint.reading': '正在读取 source/…',
  'hint.noDevices': 'source/ 里没有找到任何 device 目录。',
  'hint.noMatch': '当前筛选没有匹配的对象。',
  'hint.truncated': '只显示了前 {shown} 条，请用上面的筛选或搜索收窄范围。',

  'note.refused':
    '{count} 个对象被 TIA 拒绝导出，已按名字列在末尾（标「拒绝」，悬停看原因）；它们没有文件，右键菜单里的「打开源文件」对它们不可用。',
  'note.walked': '{device}：清单不可用（{reason}）{detail}。',
  'note.walked.none': '，目录也没有可列的文件',
  'note.walked.files': '，已改用目录列举（{count} 个文件）',
  'note.walked.truncated': '，结果被截断',

  'badge.refused': '拒绝',
  'badge.block': '块',
  'badge.type': 'UDT',
  'badge.tagTable': '表',
  'badge.file': '文件',

  'row.verifyFailed': '写后读回校验未通过',
  'row.refusedTitle': 'TIA 拒绝导出：{reason}',
  'row.refusedNoReason': '未给出原因',

  'menu.openFile': '打开源文件',
  'menu.openTitle': '这个对象没有导出文件',
  'menu.noFileRefused': 'TIA 拒绝导出，没有文件',
  'menu.noFile': '没有文件路径',
  'menu.mention': '在对话里提及',
  'menu.mentionTitle': '把 {token} 插入输入框，模型会收到这个块的引用信息',
  'menu.mentionUnrepresentable': '这个名字里有引号，无法写成提及记号',
  'mention.failed': '没能插入输入框：输入框正在发送消息，稍后再试。',

  'error.notFound': 'source/ 不存在：这个工作区还没有工程源树，先运行 create_engineering_project。',
  'error.outsideWorkspace': '这个目录在工作区之外，宿主拒绝列举。',
  'error.notDirectory': '这不是一个目录。',
  'error.notRegularFile': '这不是一个普通文件。',
  'error.tooLarge': '这个文件超过了宿主的读取上限。',
  'error.notText': '这不是文本文件。',
  'error.watchUnsupported': '这个宿主不支持目录监听，请手动刷新。',
  'error.manifestInvalid': '这个设备的清单无法解析（形状或 JSON 不对），改用目录列举。',
  'error.cancelled': '读取被取消了。',
  'error.lookupNotFound': '宿主管不到这个会话，无法读取工作区。',
  'error.gateway': '与宿主的连接出了问题（{code}），稍后重试。',
  'error.other': '读取失败（{code}）。',
}

/** English copy; the key set must match {@link zh} exactly. */
export const en = {
  'tab.title': 'PLC Blocks',
  'guide.title': 'PLC Blocks',
  'guide.description': 'PLC source files under source/, filterable by device and type',

  'action.refresh': 'Refresh',
  'action.refreshing': 'Reading…',
  'action.clear': 'Clear',

  'filter.device.all': 'All devices ({count})',
  'filter.device.label': 'Filter by device',
  'filter.type.all': 'All types ({count})',
  'filter.type.label': 'Filter by type',

  'search.placeholder': 'Search name or number',
  'search.label': 'Search by name or number',

  'hint.noWorkspace': 'This session has no workspace directory, so source/ cannot be located.',
  'hint.reading': 'Reading source/…',
  'hint.noDevices': 'No device directory was found under source/.',
  'hint.noMatch': 'Nothing matches the current filters.',
  'hint.truncated': 'Showing the first {shown} rows; narrow the filters or the search.',

  'note.refused':
    '{count} object(s) were refused by TIA and are listed by name at the end (marked "Refused", hover for the reason); they have no file, so the context menu cannot open them.',
  'note.walked': '{device}: the manifest is unusable ({reason}){detail}.',
  'note.walked.none': ', and the directory holds no listable file either',
  'note.walked.files': ', so a directory listing was used instead ({count} files)',
  'note.walked.truncated': ', and the result was truncated',

  'badge.refused': 'Refused',
  'badge.block': 'Block',
  'badge.type': 'UDT',
  'badge.tagTable': 'Table',
  'badge.file': 'File',

  'row.verifyFailed': 'the write-then-read-back check failed',
  'row.refusedTitle': 'TIA refused to export this object: {reason}',
  'row.refusedNoReason': 'no reason given',

  'menu.openFile': 'Open source file',
  'menu.openTitle': 'This object has no exported file',
  'menu.noFileRefused': 'TIA refused to export it; there is no file',
  'menu.noFile': 'No file path',
  'menu.mention': 'Mention in chat',
  'menu.mentionTitle': 'Insert {token} into the composer; the model receives this block’s reference',
  'menu.mentionUnrepresentable': 'This name contains a quote, so it cannot be spelled as a mention',
  'mention.failed': 'Could not insert it: the composer is sending a message. Try again in a moment.',

  'error.notFound': 'source/ does not exist: this workspace has no rebuilt source tree yet — run create_engineering_project first.',
  'error.outsideWorkspace': 'That directory is outside the workspace, so the host refuses to list it.',
  'error.notDirectory': 'That is not a directory.',
  'error.notRegularFile': 'That is not a regular file.',
  'error.tooLarge': 'That file exceeds the read limit of the host.',
  'error.notText': 'That is not a text file.',
  'error.watchUnsupported': 'This host cannot watch directories; refresh manually.',
  'error.manifestInvalid': "This device's manifest cannot be parsed (wrong shape or JSON), so a directory listing was used.",
  'error.cancelled': 'The read was cancelled.',
  'error.lookupNotFound': 'The host cannot resolve this session, so the workspace cannot be read.',
  'error.gateway': 'The connection to the host failed ({code}); retry later.',
  'error.other': 'Read failed ({code}).',
}
