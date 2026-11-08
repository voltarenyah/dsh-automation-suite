/**
 * The guide-page artwork for the "Changes" tab.
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
 * The glyph is a two-row diff: a removed line in blue and an added one in
 * amber.
 *
 * @module dsh-ui-changes/client/guide-icon
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
      <rect x="5.5" y="6" width="25" height="10.5" rx="3.5" stroke="#539CFA" strokeWidth="2" />
      <path d="M15 11.25h6" stroke="#539CFA" strokeWidth="2" strokeLinecap="round" />
      <rect x="5.5" y="19.5" width="25" height="10.5" rx="3.5" stroke="#FFBC4D" strokeWidth="2" />
      <path
        d="M15 24.75h6M18 21.75v6"
        stroke="#FFBC4D"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  )
}
