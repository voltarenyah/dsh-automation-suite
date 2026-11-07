/**
 * Dictionaries for the Changes tab.
 *
 * Registered through `ctx.locale.register(NS, { zh, en })`, which is what makes
 * the text follow DSH's global language setting (设置 → 通用 → 语言) without a
 * reload: the slot renderer re-renders when the namespace changes.
 *
 * Error copy is keyed by code, never by sentence: the panel resolves
 * `error.failed` / `error.http` and interpolates the code, so a new host-side
 * failure needs one dictionary entry, not a new string in the component.
 *
 * @module dsh-ui-changes/client/locales
 */

/** Namespace every key here is registered under. */
export const NS = 'changes'

/** Chinese copy. */
export const zh = {
  'tab.title': '变更',
  'guide.title': '变更',
  'guide.description': '查看未提交的文件改动，并把提交交给对话里的 agent',

  title: '变更',
  refresh: '刷新',
  loading: '正在读取…',
  noSession: '先选择一个会话，再看它的变更',

  summary: '{branch} · {head} · {files} 个文件  +{adds} −{dels}',
  summaryNoHead: '{branch} · 尚无提交 · {files} 个文件  +{adds} −{dels}',
  clean: '工作区干净：没有未提交的改动',

  'error.notRepo': '这个工作区不在 git 仓库里，没有变更可列',
  'error.noService': 'git 插件（dsh-tool-git）没有加载，变更不可用',
  'error.sessionUnknown': '找不到这个会话的工作目录',
  'error.timeout': '读取变更超时，稍后再试',
  'error.failed': '读取变更失败（{code}）',
  'error.http': '宿主路由返回了错误（{code}）',
  retry: '重试',
}

/** English copy. */
export const en = {
  'tab.title': 'Changes',
  'guide.title': 'Changes',
  'guide.description': 'Uncommitted changes at a glance, with the commit handed to the agent in chat',

  title: 'Changes',
  refresh: 'Refresh',
  loading: 'Reading…',
  noSession: 'Select a session to see its changes',

  summary: '{branch} · {head} · {files} files  +{adds} −{dels}',
  summaryNoHead: '{branch} · no commits yet · {files} files  +{adds} −{dels}',
  clean: 'Nothing to commit: the working tree is clean',

  'error.notRepo': 'This workspace is not inside a git repository',
  'error.noService': 'The git plugin (dsh-tool-git) is not loaded; changes are unavailable',
  'error.sessionUnknown': 'This session has no working directory',
  'error.timeout': 'Reading the changes timed out; try again',
  'error.failed': 'Could not read the changes ({code})',
  'error.http': 'The host route returned an error ({code})',
  retry: 'Retry',
}
