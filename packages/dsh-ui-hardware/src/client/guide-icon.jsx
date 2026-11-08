/**
 * The guide-page artwork for the "Hardware" tab.
 *
 * The right sidebar's start page renders `guide[].icon` as a component called
 * with `{ size, className }` — a 36-viewBox drawing shown at 22–26 px inside a
 * capsule. Without an `icon` the shipped guide falls back to a generic cube,
 * which is what this file replaces.
 *
 * It stays local on purpose: a browser bundle may not import another suite
 * package, and `@deepseek-ai/dsh-client-ui-primitives` ships artwork only for
 * the official tab types. The colours are fixed the same way that artwork fixes
 * them, so the glyph reads on both the light and the dark theme.
 *
 * The glyph is a CPU module: a die in its socket with four pin pairs.
 *
 * @module dsh-ui-hardware/client/guide-icon
 */

/**
 * @param {{ size?: number, className?: string }} props - the size the guide asks
 *   for (36-viewBox units) and an optional class from the renderer.
 */
export function GuideIcon({ size = 36, className }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 36 36"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <rect x="11" y="11" width="14" height="14" rx="2.6" stroke="#539CFA" strokeWidth="2" />
      <rect x="15.2" y="15.2" width="5.6" height="5.6" rx="1.2" fill="#FFBC4D" />
      <path
        d="M14.6 11V7.2M21.4 11V7.2M14.6 25v3.8M21.4 25v3.8M11 14.6H7.2M11 21.4H7.2M25 14.6h3.8M25 21.4h3.8"
        stroke="#539CFA"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  )
}
