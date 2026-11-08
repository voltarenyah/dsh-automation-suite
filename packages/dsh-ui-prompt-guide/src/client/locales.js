/**
 * Dictionaries for the sidebar row and the framed page's accessible name.
 *
 * Keys are **flat dotted strings** (`iframe.title`): the client locale service
 * looks up `dict[key]`, so a nested object would fall back to printing the key
 * itself. The rail label is re-resolved whenever the app language changes.
 *
 * @module dsh-ui-prompt-guide/client/locales
 */

/** Locale namespace used by the rail row and the panel seat. */
export const NS = 'promptGuide'

export const zh = {
  label: '提示词引导',
  'iframe.title': '提示词引导',
}

export const en = {
  label: 'Prompt Guide',
  'iframe.title': 'Prompt Guide',
}
