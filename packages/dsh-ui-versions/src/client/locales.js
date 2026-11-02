/**
 * Dictionaries for the Versions tab.
 *
 * Registered through `ctx.locale.register(NS, { zh, en })`, which is what makes
 * the text follow DSH's global language setting (设置 → 通用 → 语言) without a
 * reload: the slot renderer re-renders when the namespace changes.
 *
 * @module dsh-ui-versions/client/locales
 */

/** Namespace every key here is registered under. */
export const NS = 'versions'

/** Chinese copy. */
export const zh = {
  'tab.title': '版本',
  'guide.title': '版本',
  'guide.description': '查看版本历史、每个块的指纹变化和变更原因',

  title: 'Versions',
  device: '设备',
  workspace: '工作区',
  versions: '版本',
  changes: '变更',
  baselineObjects: '基线对象',

  search: '搜索提交、原因、块名…',
  allFaces: '全部 face',
  allProblems: '全部问题',
  history: '版本历史',
  timeline: '块时间线',
  baseline: '基线',
  blocks: '{n} 块',
  noChange: '无变更',
  baselineNote: '这是基线导入版本',
  reason: '原因',
  problem: '问题',
  pickBlock: '点击版本里的块名，查看它的时间线',
  noMatch: '没有匹配的版本',
  changesCount: '{n} 次变更',
  none: '这个块还没有变更记录',
  modified: '修改',
  added: '新增',
  removed: '删除',
  faceChange: '{face} 变更',
  resize: '拖动调整两栏宽度',

  refresh: '刷新',
  loading: '正在读取版本数据…',
  noWorkspace: '当前会话没有工作区目录，无法读取版本数据。',
  readFailed: '读取版本数据失败：{code}',
  noView: '这个工作区还没有版本视图。先提交一次，或在会话里运行 project_version_reindex。',
  invalidView: '版本视图文件无法解析：{code}',
  retry: '重试',
}

/** English copy. */
export const en = {
  'tab.title': 'Versions',
  'guide.title': 'Versions',
  'guide.description': 'Version history, per-block fingerprint changes and the reason behind each change',

  title: 'Versions',
  device: 'Device',
  workspace: 'Workspace',
  versions: 'versions',
  changes: 'changes',
  baselineObjects: 'baseline objects',

  search: 'Search commits, reasons, blocks…',
  allFaces: 'All faces',
  allProblems: 'All problems',
  history: 'Version history',
  timeline: 'Block timeline',
  baseline: 'Baseline',
  blocks: '{n} block(s)',
  noChange: 'No changes',
  baselineNote: 'Baseline import',
  reason: 'Reason',
  problem: 'Problem',
  pickBlock: 'Click a block name in a version to see its timeline',
  noMatch: 'No matching versions',
  changesCount: '{n} change(s)',
  none: 'This block has no changes yet',
  modified: 'modified',
  added: 'added',
  removed: 'removed',
  faceChange: '{face} change',
  resize: 'Drag to resize the two columns',

  refresh: 'Refresh',
  loading: 'Reading version data…',
  noWorkspace: 'This session has no workspace directory, so there is no version data to read.',
  readFailed: 'The version data could not be read: {code}',
  noView: 'No version view for this workspace yet. Make a commit, or run project_version_reindex in the session.',
  invalidView: 'The version view could not be parsed: {code}',
  retry: 'Retry',
}
