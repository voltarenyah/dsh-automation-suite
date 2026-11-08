/**
 * The guide-page artwork for the "PLC Blocks" tab.
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
 * The glyph is a program block: one rounded block with a code chevron pair.
 *
 * @module dsh-ui-plc-source/client/guide-icon
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
      <rect x="6.5" y="6.5" width="23" height="23" rx="4.5" stroke="#539CFA" strokeWidth="2" />
      <path
        d="m16 13.5-4.5 4.5 4.5 4.5M20 13.5l4.5 4.5-4.5 4.5"
        stroke="#FFBC4D"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
