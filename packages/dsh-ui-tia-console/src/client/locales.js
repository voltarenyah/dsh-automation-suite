/**
 * The console bar's copy, in both built-in locales.
 *
 * Registered through `ctx.locale.register(NS, { zh, en })`; both locales must
 * carry the same key set, and `test/locales.test.mjs` fails if they drift.
 *
 * @module dsh-ui-tia-console/locales
 */

/** Namespace every key here is registered under. */
export const NS = 'tiaConsole'

/** Simplified Chinese dictionary. */
export const zh = {
  'state.unknown': 'TIA 状态未检测',
  'state.unavailable': 'TIA 不可用',
  'state.idle': 'TIA 无项目',
  'state.open': 'TIA 已打开',
  'state.openUnknown': '已打开的项目',

  'action.open': '打开',
  'action.save': '保存',
  'action.compile': '编译',
  'action.close': '关闭',
  'action.refresh': '刷新',

  'op.open': '正在打开',
  'op.save': '正在保存',
  'op.compile': '正在编译',
  'op.close': '正在关闭',
  'op.create': '正在新建',
  'op.refresh': '正在刷新状态',
  'op.query': '正在查询',
  'op.status': '正在查询状态',
  'op.export': '正在导出',
  'op.import': '正在导入',
  'op.busy': '正在执行 TIA 操作',

  'badge.compiled': '已编译 {errors} 错误 / {warnings} 警告',
  'badge.saved': '已保存',

  'detail.project': '项目',
  'detail.path': '路径',
  'detail.since': '打开于',
  'detail.modified': '有未保存修改',
  'detail.compile': '最近编译',
  'detail.lastError': '最近错误',
  'detail.lastResult': '最近结果',
  'detail.scope': '状态来自本会话的 TIA 操作记录；其他会话或外部关闭 TIA 后，点「刷新」校准。',
  'detail.projectNone': '当前没有打开的项目。',
  'detail.none': '暂无更多信息。',

  'value.yes': '是',
  'value.no': '否',
  'value.unknown': '未知',

  'aria.expand': '展开 TIA 详细信息',
  'aria.collapse': '收起 TIA 详细信息',
  'aria.status': 'TIA 状态',
}

/** English copy; the key set must match {@link zh} exactly. */
export const en = {
  'state.unknown': 'TIA state not checked',
  'state.unavailable': 'TIA unavailable',
  'state.idle': 'TIA has no project',
  'state.open': 'TIA open',
  'state.openUnknown': 'open project',

  'action.open': 'Open',
  'action.save': 'Save',
  'action.compile': 'Compile',
  'action.close': 'Close',
  'action.refresh': 'Refresh',

  'op.open': 'Opening',
  'op.save': 'Saving',
  'op.compile': 'Compiling',
  'op.close': 'Closing',
  'op.create': 'Creating',
  'op.refresh': 'Refreshing state',
  'op.query': 'Querying',
  'op.status': 'Reading controller state',
  'op.export': 'Exporting',
  'op.import': 'Importing',
  'op.busy': 'Running a TIA operation',

  'badge.compiled': 'compiled {errors} err / {warnings} warn',
  'badge.saved': 'saved',

  'detail.project': 'Project',
  'detail.path': 'Path',
  'detail.since': 'Open since',
  'detail.modified': 'Unsaved changes',
  'detail.compile': 'Last compile',
  'detail.lastError': 'Last error',
  'detail.lastResult': 'Last result',
  'detail.scope': 'State is derived from this session’s TIA operations; after another session or an external TIA close, use Refresh.',
  'detail.projectNone': 'No project is open.',
  'detail.none': 'No further detail.',

  'value.yes': 'yes',
  'value.no': 'no',
  'value.unknown': 'unknown',

  'aria.expand': 'Expand TIA details',
  'aria.collapse': 'Collapse TIA details',
  'aria.status': 'TIA state',
}
