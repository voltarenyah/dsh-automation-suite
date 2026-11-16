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
  'filter': '筛选图号 / 标题 / 页面文字',
  'matches': '页匹配',
  'noMatches': '没有匹配的图纸页',
  'textIndexMissing': '全文索引尚未建立：当前只按图号/标题/位号搜索。请让 agent 重新执行 drawing_open 重建索引。',
  'allCabinets': '全部电柜',
  'caveats': '注意',
  'sheet': '图号',
  'title': '标题',
  'cabinet': '电柜',
  'hint': '点上方目录任一页，底部 PDF 会跳到该页；也可以直接在 PDF 里滚动浏览整份图纸。',
  'loadingPdf': '正在载入 PDF…',
  'pdfError': 'PDF 载入失败。',
  'agentView': '定位',
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
  'filter': 'Filter sheet no. / title / page text',
  'matches': 'pages match',
  'noMatches': 'No matching sheets',
  'textIndexMissing':
    'Full-text index not built yet — searching sheet numbers/titles/tags only. Ask the agent to re-run drawing_open to build it.',
  'allCabinets': 'All cabinets',
  'caveats': 'Caveats',
  'sheet': 'Sheet',
  'title': 'Title',
  'cabinet': 'Cabinet',
  'hint': 'Pick a sheet above to jump the PDF below; you can also scroll the whole set right here.',
  'loadingPdf': 'Loading PDF…',
  'pdfError': 'Could not load the PDF.',
  'agentView': 'Located',
  'documents': 'Drawings',
  'error': 'read failed',
}


