/**
 * Home-page hero copy for the suite's desktop distribution.
 *
 * The hero belongs to DSH's own conversation client: its headline and preview
 * badge are i18n strings (`conversation` namespace, keys `hero.headline` and
 * `hero.preview`), not configuration. The official brand plugin deliberately
 * leaves the hero to that package, and no Loader config can rename it — so this
 * plugin overrides the two lookups at the browser's locale service, the one
 * seam every `t()` call in the app shares.
 *
 * Keeping the mapping in a pure module is what makes it testable: the client
 * half is a bundle, but the rule it applies is plain data.
 *
 * @module dsh-ui-brandmark/model
 */

/** i18n namespace that owns the hero strings (the conversation client bundle). */
export const HERO_NAMESPACE = 'conversation'

/** Headline shown next to the hero mark, in place of "Into the Unknown". */
export const HERO_HEADLINE = 'dsh-automation-suite'

/** Badge shown beside the headline, in place of "Preview". */
export const HERO_PREVIEW = 'TIA-V17'

/**
 * Resolve the replacement copy for one translation lookup.
 *
 * Returning `undefined` (rather than a copy of the original text) is
 * load-bearing: the client falls through to the real dictionary, so every other
 * string — including both locales and future keys — keeps working untouched.
 *
 * @param namespace - i18n namespace of the lookup.
 * @param key - message key inside that namespace.
 * @returns the replacement text, or undefined when the lookup is not ours.
 */
export function heroCopy(namespace: string, key: string): string | undefined {
  if (namespace !== HERO_NAMESPACE) return undefined
  if (key === 'hero.headline') return HERO_HEADLINE
  if (key === 'hero.preview') return HERO_PREVIEW
  return undefined
}
