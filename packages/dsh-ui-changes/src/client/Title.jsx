/**
 * The tab chip's label seat.
 *
 * A tab record freezes the title text it was opened with, so the chip needs a
 * seat of its own to keep following the active locale.
 *
 * @module dsh-ui-changes/client/Title
 */

/**
 * @param {{ t: (key: string) => string }} props - the translate seat.
 */
export function Title(props) {
  return <span>{props.t('tab.title')}</span>
}
