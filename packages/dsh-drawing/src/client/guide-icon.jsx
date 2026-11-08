/**
 * The guide-page artwork for the "Drawings" tab.
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
 * The glyph is a technical sheet: a folded page carrying a small plan view in
 * amber.
 *
 * @module dsh-drawing/client/guide-icon
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
      <path
        d="M8 6h12l6 6v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"
        stroke="#539CFA"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M20 6v6h6" stroke="#539CFA" strokeWidth="2" strokeLinejoin="round" />
      <rect x="10.5" y="14.5" width="7.5" height="11" rx="1" stroke="#FFBC4D" strokeWidth="2" />
      <rect x="18" y="19.5" width="6.5" height="6" rx="1" stroke="#FFBC4D" strokeWidth="2" />
    </svg>
  )
}
