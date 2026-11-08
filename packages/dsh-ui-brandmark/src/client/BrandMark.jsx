/**
 * The hero mark: the desktop shell's app icon, sized by the host surface.
 *
 * The slot is a single root slot whose fallback is the animated fish. The host
 * passes the same presentation props it gives that fallback (`size` and a
 * `className`), so the icon keeps the row's alignment and only the artwork
 * changes. The PNG is inlined as a data URL at build time — the browser half
 * has no route of its own to serve assets from.
 *
 * @module dsh-ui-brandmark/client/BrandMark
 */

import iconUrl from '../../assets/brandmark.png'

/** Fallback edge length when the host does not pass a usable `size`. */
const DEFAULT_SIZE = 34

/**
 * Render the suite icon for the conversation hero.
 *
 * @param props - host-supplied presentation.
 * @param props.size - edge length in CSS pixels.
 * @param props.className - the hero's own class (alignment, hitbox).
 * @returns the icon as an image element.
 */
export function BrandMark({ size, className }) {
  const pixels = typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : DEFAULT_SIZE
  return (
    <img
      src={iconUrl}
      width={pixels}
      height={pixels}
      alt="dsh-automation-suite"
      className={className}
      draggable={false}
      style={{ display: 'block', borderRadius: Math.round(pixels * 0.24) }}
    />
  )
}
