/**
 * Dictionaries for the Drawing tab.
 *
 * @module dsh-drawing/client/locales
 */

/** Translation namespace; also the `locale` seat key. */
export const NS = 'dsh-drawing'

export const zh = {
  'tab.title': '图纸',
  'guide.title': '图纸',
  'guide.description': '检索电气图纸元素，查看图纸页面。',
  'empty.title': '这个工作区还没有图纸',
  'empty.hint': '把图纸 PDF 的路径告诉 agent，或在对话里上传附件；它会复制到 drawing/ 并建立索引。',
  'loading': '读取索引…',
  'lookedIn': '查找过',
  'noIndex': '未建索引',
  'sheets': '张图纸',
  'pages': '页',
  'filter': '筛选图号 / 标题',
  'allCabinets': '全部电柜',
  'caveats': '注意',
  'sheet': '图号',
  'title': '标题',
  'cabinet': '电柜',
  'preview': '点左侧任一图号，用浏览器自带的阅读器打开该页；agent 调用 drawing_show 时会在这里显示带命中标记的页面。',
  'agentView': '当前定位',
  'documents': '图纸',
  'error': '读取失败',
}

export const en = {
  'tab.title': 'Drawing',
  'guide.title': 'Drawing',
  'guide.description': 'Search electrical drawing elements and view drawing pages.',
  'empty.title': 'No drawing in this workspace yet',
  'empty.hint': 'Give the agent a PDF path (or upload the file in chat); it is copied into drawing/ and indexed.',
  'loading': 'Reading index…',
  'lookedIn': 'Looked in',
  'noIndex': 'not indexed',
  'sheets': 'sheets',
  'pages': 'pages',
  'filter': 'Filter sheet no. / title',
  'allCabinets': 'All cabinets',
  'caveats': 'Caveats',
  'sheet': 'Sheet',
  'title': 'Title',
  'cabinet': 'Cabinet',
  'preview': 'Pick a sheet on the left to open it in the browser viewer; when the agent calls drawing_show this pane shows the page with the hit marked.',
  'agentView': 'Last shown',
  'documents': 'Drawings',
  'error': 'read failed',
}


