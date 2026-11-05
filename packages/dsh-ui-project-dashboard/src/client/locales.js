/**
 * Dictionaries for the global panel row and the P0 page.
 *
 * The rail label stays `Project Dashboard` in both languages (it is the name the
 * product asked for); everything inside the page follows the active locale.
 *
 * @module dsh-ui-project-dashboard/client/locales
 */

/** Locale namespace used by both seats. */
export const NS = 'projectDashboard'

export const zh = {
  panel: 'Project Dashboard',
  eyebrow: '全局面板 · P0',
  title: 'Project Dashboard',
  lead: '链路已打通：左侧栏入口与整页面板都已注册。P1 接入标签与搜索，P2 接入工程数据。',
  statusTitle: '注册结果',
  idLabel: '面板 id',
  seatLabel: '座位',
  seatValue: 'sidebar.panellist → main',
  orderLabel: '顺序',
  orderValue: '-10（Plugins 之上）',
  localeLabel: '本地化',
  localeValue: '中 / 英（跟随应用语言）',
  nextTitle: '下一步',
  next1: '工作区行、多级标签、顶部搜索与标签筛选',
  next2: '工程 / 硬件 / 版本 / 图纸四个派生视图',
  next3: '输入防抖、按需重渲染、无障碍与文档同步',
  note: '本页是 P0 占位。数据接入与取舍见 docs/research/project-dashboard-feasibility.md。',
  probe: '已执行 apply()'
}

export const en = {
  panel: 'Project Dashboard',
  eyebrow: 'GLOBAL PANEL · P0',
  title: 'Project Dashboard',
  lead: 'The chain is wired: the sidebar entry and the full-page panel are registered. P1 adds tags and search; P2 adds engineering data.',
  statusTitle: 'Registration',
  idLabel: 'Panel id',
  seatLabel: 'Seats',
  seatValue: 'sidebar.panellist → main',
  orderLabel: 'Order',
  orderValue: '-10 (above Plugins)',
  localeLabel: 'Locale',
  localeValue: 'zh / en (follows the app language)',
  nextTitle: 'Next',
  next1: 'workspace rows, multi-level tags, top search and tag filtering',
  next2: 'engineering / hardware / versions / drawings views',
  next3: 'input debounce, targeted re-render, a11y and docs',
  note: 'This page is the P0 placeholder. Data design and trade-offs live in docs/research/project-dashboard-feasibility.md.',
  probe: 'apply() ran'
}
