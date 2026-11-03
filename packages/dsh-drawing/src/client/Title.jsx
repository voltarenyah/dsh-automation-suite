/**
 * The tab chip. Rendered by its own seat because a tab record freezes the title
 * text it was opened with.
 *
 * @module dsh-drawing/client/Title
 */

/**
 * @param {{ t: (key: string) => string }} props - bound translator.
 */
export function Title({ t }) {
  return t('tab.title')
}
