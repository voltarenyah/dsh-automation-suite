/**
 * Dictionaries for the global panel row and the dashboard page.
 *
 * Keys are **flat dotted strings** (`search.placeholder`, `ledger.workspaces`):
 * the client locale service looks up `dict[key]`, so a nested object would fall
 * back to printing the key itself. `t(key, params)` interpolates `{name}`.
 *
 * @module dsh-ui-project-dashboard/client/locales
 */

/** Locale namespace used by both seats. */
export const NS = 'projectDashboard'

export const zh = {
  panel: 'Project Dashboard',
  eyebrow: '全局面板 · P1',
  title: 'Project Dashboard',
  subtitle: '所有工作区的一页总览 · 会话、标签与分组',
  'board.title': '工作区列表',

  'search.placeholder': '搜索项目、路径、标签…',
  'search.clear': '清除搜索',

  'filter.tags': '标签',
  'filter.title': '按标签筛选',
  'filter.clear': '清除',
  'filter.empty': '还没有标签。用行内的「+ 标签」添加。',
  'filter.remove': '移除筛选 {tag}',

  result: '{shown} / {total} 个工作区',

  'ledger.title': '全局汇总',
  'ledger.workspaces': 'Workspaces',
  'ledger.workspacesMeta': '{n} 个已注册',
  'ledger.sessions': 'Sessions',
  'ledger.sessionsMeta': '{archived} 归档 · {running} 运行 · {pending} 待处理',
  'ledger.blocks': 'Blocks',
  'ledger.io': 'I/O',
  'ledger.versions': 'Versions',
  'ledger.drawings': 'Drawings',
  'ledger.p2': 'P2 接入',

  'row.sessions': '{n} 会话',
  'row.archived': '{n} 归档',
  'row.blank': '{n} 空白',
  'row.running': '{n} 个会话正在运行',
  'row.pending': '{n} 个会话等待处理',
  'row.noTags': '还没有标签',
  'row.addTag': '+ 标签',
  'row.filterBy': '按 {tag} 筛选',
  'row.removeTag': '移除标签',
  'row.open': '打开工作区',
  'row.newSession': '新会话',

  'time.justNow': '刚刚',
  'time.minutes': '{n} 分钟前',
  'time.hours': '{n} 小时前',
  'time.days': '{n} 天前',

  'tag.added': '已添加标签 {tag}',
  'tag.removed': '已移除标签 {tag}',
  'tag.exists': '标签 {tag} 已存在',
  'tag.invalid': '标签格式不对（最多 4 级，每级 40 字）',

  'tags.conflict': '标签已被另一个窗口修改，已刷新',
  'tags.saveFailed': '标签保存失败：{code}',
  'tags.network': '连不上标签服务（宿主未运行或路由不可用）',
  'tags.error': '标签读取失败：{code}',
  'tags.retry': '重试',
  'tags.corrupt': '标签文件无法解析：已显示空标签，下一次保存会把损坏文件另存后再写。',

  'editor.title': '添加标签',
  'editor.placeholder': '例如 客户/PEI',
  'editor.hint': '用 / 分层（最多 4 级） · Enter 添加 · Esc 关闭',

  'empty.none': '还没有工作区',
  'empty.noneHint': '在左侧栏新建会话，工作区会出现在这里。',
  'empty.filtered': '没有匹配的工作区',
  'empty.filteredHint': '换关键词，或清空标签筛选。',
  'empty.clear': '清除搜索与筛选',

  'act.unavailable': '工作区导航暂不可用（uiWorkspace 未提供）',

  'default.banner': '这个发行版不使用默认工作区；它仍在左侧栏注册着。',
  'default.remove': '移除默认工作区',
  'default.removed': '已移除默认工作区（文件夹与会话保留，会话归入未分组）',
  'default.absent': '默认工作区已经不在了',
  'default.failed': '移除默认工作区失败：{code}',

  footnote: '标签保存在本机 DSH 数据目录（storages/project-dashboard/tags.json）；页面不在后台跑宿主命令，只在打开时读一次、编辑时写一次。'
}

export const en = {
  panel: 'Project Dashboard',
  eyebrow: 'GLOBAL PANEL · P1',
  title: 'Project Dashboard',
  subtitle: 'One page over every workspace — sessions, tags and grouping',
  'board.title': 'Workspaces',

  'search.placeholder': 'Search projects, paths, tags…',
  'search.clear': 'Clear search',

  'filter.tags': 'Tags',
  'filter.title': 'Filter by tag',
  'filter.clear': 'Clear',
  'filter.empty': 'No tags yet. Add one with "+ Tag" on a row.',
  'filter.remove': 'Remove filter {tag}',

  result: '{shown} / {total} workspaces',

  'ledger.title': 'Totals',
  'ledger.workspaces': 'Workspaces',
  'ledger.workspacesMeta': '{n} registered',
  'ledger.sessions': 'Sessions',
  'ledger.sessionsMeta': '{archived} arch · {running} run · {pending} wait',
  'ledger.blocks': 'Blocks',
  'ledger.io': 'I/O',
  'ledger.versions': 'Versions',
  'ledger.drawings': 'Drawings',
  'ledger.p2': 'P2',

  'row.sessions': '{n} sessions',
  'row.archived': '{n} archived',
  'row.blank': '{n} blank',
  'row.running': '{n} sessions running',
  'row.pending': '{n} sessions waiting',
  'row.noTags': 'No tags yet',
  'row.addTag': '+ Tag',
  'row.filterBy': 'Filter by {tag}',
  'row.removeTag': 'Remove tag',
  'row.open': 'Open workspace',
  'row.newSession': 'New session',

  'time.justNow': 'just now',
  'time.minutes': '{n}m ago',
  'time.hours': '{n}h ago',
  'time.days': '{n}d ago',

  'tag.added': 'Tag {tag} added',
  'tag.removed': 'Tag {tag} removed',
  'tag.exists': 'Tag {tag} already exists',
  'tag.invalid': 'Invalid tag (4 levels max, 40 characters each)',

  'tags.conflict': 'Tags changed in another window — reloaded',
  'tags.saveFailed': 'Could not save tags: {code}',
  'tags.network': 'Tag service unreachable (host not running or route unavailable)',
  'tags.error': 'Could not load tags: {code}',
  'tags.retry': 'Retry',
  'tags.corrupt': 'The tag file could not be parsed. Empty tags are shown; the next save keeps a copy of the damaged file.',

  'editor.title': 'Add tag',
  'editor.placeholder': 'e.g. Customer/PEI',
  'editor.hint': 'Use / for levels (max 4) · Enter to add · Esc to close',

  'empty.none': 'No workspaces yet',
  'empty.noneHint': 'Start a session in the sidebar and its workspace appears here.',
  'empty.filtered': 'No matching workspaces',
  'empty.filteredHint': 'Try another query, or clear the tag filter.',
  'empty.clear': 'Clear search and filters',

  'act.unavailable': 'Workspace navigation is unavailable (uiWorkspace not provided)',

  'default.banner': 'This distribution does not use a default workspace, but one is still registered in the sidebar.',
  'default.remove': 'Remove default workspace',
  'default.removed': 'Default workspace removed (folder and sessions kept; sessions move to Ungrouped)',
  'default.absent': 'The default workspace is already gone',
  'default.failed': 'Could not remove the default workspace: {code}',

  footnote: 'Tags are stored in this machine\'s DSH data directory (storages/project-dashboard/tags.json). The page runs no background host work: one read on open, one write per edit.'
}
