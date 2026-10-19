/**
 * The tab chip's content.
 *
 * It has to be a registered seat rather than only the type's `title()` thunk: a
 * tab record captures its title text when the tab is minted, so without a title
 * registration the chip would keep whatever language was active at that moment.
 * Registering here makes the chip re-render with the locale, like the body does.
 *
 * @module dsh-ui-plc-source/Title
 */

/** Identity fallback for the translate seat; keys pass through unchanged. */
const identity = (key) => key

/**
 * @param {object} props - framework props (t seat, injected face).
 * @returns {object} the chip content.
 */
export function Title(props) {
  const t =
    typeof props.t === 'function'
      ? props.t
      : typeof props.translate === 'function'
        ? props.translate
        : identity
  return <span className="plps-chip">{t('tab.title')}</span>
}
