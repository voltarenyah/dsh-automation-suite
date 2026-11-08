/**
 * The guide-page artwork for the "Versions" tab.
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
 * The glyph is a history timeline: one rail with three milestones, the newest
 * one in amber.
 *
 * @module dsh-ui-versions/client/guide-icon
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
      <path d="M12 8.5v19" stroke="#539CFA" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="12" cy="10.5" r="3.2" fill="#FFBC4D" />
      <circle cx="12" cy="18" r="3.2" fill="#539CFA" />
      <circle cx="12" cy="25.5" r="3.2" fill="#539CFA" />
      <path
        d="M18.5 10.5h6M18.5 18h9M18.5 25.5h5"
        stroke="#539CFA"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  )
}
