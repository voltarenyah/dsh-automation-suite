/**
 * Dictionaries for the global panel row and the dashboard page.
 *
 * Keys are **flat dotted strings** (`search.placeholder`, `filter.title`):
 * the client locale service looks up `dict[key]`, so a nested object would fall
 * back to printing the key itself. `t(key, params)` interpolates `{name}`.
 *
 * Data-sheet micro-labels (column heads, SEARCH/TAGS caps) stay English in both
 * locales: they are part of the instrument look, not UI copy.
 *
 * @module dsh-ui-project-dashboard/client/locales
 */

/** Locale namespace used by both seats. */
export const NS = 'projectDashboard'

export const zh = {
  panel: '项目看板',
  kicker: 'GLOBAL WORKSPACE INDEX · LOCAL TAGS',
  title: '项目看板',
  subtitle: '所有工作区的一页总览 · 会话、标签与分组',

  searchCap: 'SEARCH',
  'search.placeholder': '搜索项目、路径、标签…',
  'search.clear': '清除搜索',

  filterCap: 'TAGS',
  'filter.tags': '标签',
  'filter.title': '按标签筛选',
  'filter.all': '全部工作区',
  'filter.clear': '清除',
  'filter.clearAll': '清除全部',
  'filter.hint': '点选标签 · Esc 关闭',
  'filter.done': '完成',
  'filter.empty': '还没有标签。用行内的「+ 标签」添加。',
  'filter.untagged': '未标记',
  'filter.remove': '移除筛选 {tag}',

  newSession: '新会话',
  newSessionFor: '为 {title} 新建会话',
  addTag: '+ 标签',
  addTagFor: '为 {title} 添加标签',
  filterBy: '按 {tag} 筛选',
  removeTag: '移除标签 {tag}',
  noTags: '还没有标签',

  sesLabel: 'SESSIONS',
  lastLabel: 'LAST ACTIVE',
  runningN: '{n} 运行中',
  pendingN: '{n} 待处理',

  statWorkspaces: 'WORKSPACES',
  statSessions: 'SESSIONS',
  statRunning: 'RUNNING',
  statWaiting: 'WAITING',
  wsMeta: '{n} 个已注册',
  sessionsMeta: '{archived} 归档 · {running} 运行 · {pending} 待处理',
  noRunning: '没有会话正在运行',
  runningMeta: '{n} 个会话正在运行',
  noWaiting: '没有会话等待处理',
  waitingMeta: '{n} 个会话等待处理',
  activity: 'ACTIVITY',
  days14: '14 DAYS',
  localSessions: 'LOCAL SESSIONS',
  signalAria: '过去 14 天共 {n} 个会话',

  registerTitle: '工作区',
  registerNote: '按最后活动排序',
  registerCount: '{shown} / {total}',

  colIndex: '#',
  colWorkspace: 'WORKSPACE / TAGS',
  colActivity: '14-DAY ACTIVITY',
  colSessions: 'SESSIONS',
  colLast: 'LAST ACTIVE',

  'time.justNow': '刚刚',
  'time.minutes': '{n} 分钟前',
  'time.hours': '{n} 小时前',
  'time.days': '{n} 天前',

  'tag.added': '已添加标签 {tag}',
  'tag.removed': '已移除标签 {tag}',
  'tag.exists': '标签 {tag} 已存在',
  'tag.invalid': '标签格式不对（最多 4 级，每级 40 字）',

  'editor.title': '添加标签',
  'editor.placeholder': '例如 客户/PEI',
  'editor.hint': '用 / 分层（最多 4 级） · Enter 添加 · Esc 关闭',
  'editor.invalid': '标签格式不对：最多 4 级，每级 40 字',
  'editor.exists': '标签 {tag} 已存在',

  'tags.conflict': '标签已被另一个窗口修改，已刷新',
  'tags.saveFailed': '标签保存失败：{code}',
  'tags.network': '连不上标签服务（宿主未运行或路由不可用）',
  'tags.error': '标签读取失败：{code}',
  'tags.retry': '重试',
  'tags.corruptTitle': '标签文件已损坏',
  'tags.corrupt': '标签文件无法解析：已显示空标签，下一次保存会把损坏文件另存后再写。',

  'empty.none': '还没有工作区',
  'empty.noneHint': '在左侧栏新建会话，工作区会出现在这里。',
  'empty.filtered': '没有匹配的工作区',
  'empty.filteredHint': '换关键词，或清空标签筛选。',
  'empty.clear': '清除搜索与筛选',

  'act.unavailable': '工作区导航暂不可用（uiWorkspace 未提供）',

  'default.title': '默认工作区仍处于注册状态',
  'default.copy': '这个发行版不使用默认工作区；它仍在左侧栏注册着。',
  'default.remove': '移除默认工作区',
  'default.removed': '已移除默认工作区（文件夹与会话保留，会话归入未分组）',
  'default.absent': '默认工作区已经不在了',
  'default.failed': '移除默认工作区失败：{code}',

  'store.label': '存储说明',
  'store.copy': '标签保存在本机 DSH 数据目录（storages/project-dashboard/tags.json）；页面不在后台跑宿主命令，只在打开时读一次、编辑时写一次。'
}

export const en = {
  panel: 'Project Dashboard',
  kicker: 'GLOBAL WORKSPACE INDEX · LOCAL TAGS',
  title: 'Project Dashboard',
  subtitle: 'One page over every workspace — sessions, tags and grouping',

  searchCap: 'SEARCH',
  'search.placeholder': 'Search projects, paths, tags…',
  'search.clear': 'Clear search',

  filterCap: 'TAGS',
  'filter.tags': 'Tags',
  'filter.title': 'Filter by tag',
  'filter.all': 'All workspaces',
  'filter.clear': 'Clear',
  'filter.clearAll': 'Clear all',
  'filter.hint': 'Pick tags · Esc to close',
  'filter.done': 'Done',
  'filter.empty': 'No tags yet. Add one with "+ Tag" on a row.',
  'filter.untagged': 'Untagged',
  'filter.remove': 'Remove filter {tag}',

  newSession: 'New session',
  newSessionFor: 'New session for {title}',
  addTag: '+ Tag',
  addTagFor: 'Add a tag to {title}',
  filterBy: 'Filter by {tag}',
  removeTag: 'Remove tag {tag}',
  noTags: 'No tags yet',

  sesLabel: 'SESSIONS',
  lastLabel: 'LAST ACTIVE',
  runningN: '{n} running',
  pendingN: '{n} waiting',

  statWorkspaces: 'WORKSPACES',
  statSessions: 'SESSIONS',
  statRunning: 'RUNNING',
  statWaiting: 'WAITING',
  wsMeta: '{n} registered',
  sessionsMeta: '{archived} arch · {running} run · {pending} wait',
  noRunning: 'No sessions running',
  runningMeta: '{n} sessions running',
  noWaiting: 'No sessions waiting',
  waitingMeta: '{n} sessions waiting',
  activity: 'ACTIVITY',
  days14: '14 DAYS',
  localSessions: 'LOCAL SESSIONS',
  signalAria: '{n} sessions over the last 14 days',

  registerTitle: 'Workspaces',
  registerNote: 'Ordered by last activity',
  registerCount: '{shown} / {total}',

  colIndex: '#',
  colWorkspace: 'WORKSPACE / TAGS',
  colActivity: '14-DAY ACTIVITY',
  colSessions: 'SESSIONS',
  colLast: 'LAST ACTIVE',

  'time.justNow': 'just now',
  'time.minutes': '{n}m ago',
  'time.hours': '{n}h ago',
  'time.days': '{n}d ago',

  'tag.added': 'Tag {tag} added',
  'tag.removed': 'Tag {tag} removed',
  'tag.exists': 'Tag {tag} already exists',
  'tag.invalid': 'Invalid tag (4 levels max, 40 characters each)',

  'editor.title': 'Add tag',
  'editor.placeholder': 'e.g. Customer/PEI',
  'editor.hint': 'Use / for levels (max 4) · Enter to add · Esc to close',
  'editor.invalid': 'Invalid tag: 4 levels max, 40 characters each',
  'editor.exists': 'Tag {tag} already exists',

  'tags.conflict': 'Tags changed in another window — reloaded',
  'tags.saveFailed': 'Could not save tags: {code}',
  'tags.network': 'Tag service unreachable (host not running or route unavailable)',
  'tags.error': 'Could not load tags: {code}',
  'tags.retry': 'Retry',
  'tags.corruptTitle': 'Tag file damaged',
  'tags.corrupt': 'The tag file could not be parsed. Empty tags are shown; the next save keeps a copy of the damaged file.',

  'empty.none': 'No workspaces yet',
  'empty.noneHint': 'Start a session in the sidebar and its workspace appears here.',
  'empty.filtered': 'No matching workspaces',
  'empty.filteredHint': 'Try another query, or clear the tag filter.',
  'empty.clear': 'Clear search and filters',

  'act.unavailable': 'Workspace navigation is unavailable (uiWorkspace not provided)',

  'default.title': 'Default workspace still registered',
  'default.copy': 'This distribution does not use a default workspace, but one is still registered in the sidebar.',
  'default.remove': 'Remove default workspace',
  'default.removed': 'Default workspace removed (folder and sessions kept; sessions move to Ungrouped)',
  'default.absent': 'The default workspace is already gone',
  'default.failed': 'Could not remove the default workspace: {code}',

  'store.label': 'Storage note',
  'store.copy': 'Tags are stored in this machine\'s DSH data directory (storages/project-dashboard/tags.json). The page runs no background host work: one read on open, one write per edit.'
}
