/**
 * Browser half: the suite's home-page hero branding.
 *
 * Two independent overrides, because the hero is built from two different
 * extension seams:
 *
 *  - The headline and the "Preview" badge are i18n strings owned by the
 *    conversation client. There is no config knob and no slot for them, so the
 *    locale service's `translate` is wrapped: only the two `conversation` keys
 *    are answered here, every other lookup falls through to the real
 *    dictionary. The wrap is installed and removed by one effect, and a
 *    `publish` after each change re-renders the locale subscribers so the
 *    replacement shows without a reload.
 *  - The mark is a declared single slot (`conversation.hero.brand.mark`) whose
 *    fallback is the animated fish. Registering an occupant replaces that
 *    fallback; the desktop shell's icon is the occupant here.
 *
 * Both pieces fail soft: a missing locale method or an unavailable slot warns
 * once and leaves the stock hero alone instead of breaking the page.
 *
 * @module dsh-ui-brandmark/client
 */

import { BrandMark } from './BrandMark.jsx'
import { heroCopy } from '../model'

/** Package name; also the slot key this plugin occupies. */
export const ID = 'dsh-ui-brandmark'

/** Cordis services the body needs (`slots` for the mark, `locale` for the copy). */
export const inject = ['slots', 'locale']

/** The single mark slot declared by the conversation client's hero. */
const HERO_MARK_SLOT = 'conversation.hero.brand.mark'

/** Marks the locale instance as patched, so a reload cannot stack wrappers. */
const PATCH_KEY = '__dshUiBrandmarkHeroCopy'

/**
 * Ask the locale runtime to notify its subscribers (i.e. re-render the hero).
 *
 * `publish` advances the snapshot revision, which is what translation
 * subscribers watch; it is safe to call twice and its failure is cosmetic.
 *
 * @param locale - the locale runtime instance.
 * @param ctx - client root context, for the warning channel.
 * @param reason - short description used in the warning.
 */
function publish(locale, ctx, reason) {
  try {
    const snapshot = locale.getSnapshot()
    if (snapshot !== undefined && snapshot !== null && typeof locale.publish === 'function') {
      locale.publish(snapshot.active, false)
    }
  } catch (error) {
    ctx.logger?.warn?.(`${ID}: ${reason}: ${String(error)}`)
  }
}

/**
 * Wrap the locale instance's `translate` with the hero copy override.
 *
 * The bound translator every component holds is `(key, params) => this.translate(ns, key, params)`,
 * so shadowing the instance method — not the prototype — is what reaches
 * already-bound `t` functions without touching React.
 *
 * @param ctx - client root context.
 * @returns a disposer that restores the untouched translator.
 */
function patchHeroCopy(ctx) {
  const locale = ctx.locale
  if (locale === undefined || locale === null || typeof locale.translate !== 'function') {
    ctx.logger?.warn?.(`${ID}: the locale service has no translate(); the hero copy is unchanged`)
    return () => {}
  }
  if (locale[PATCH_KEY] !== undefined) return () => {}

  const original = locale.translate
  locale.translate = function patched(namespace, key, params) {
    const copy = heroCopy(namespace, key)
    if (copy !== undefined) return copy
    return original.call(this, namespace, key, params)
  }
  locale[PATCH_KEY] = { original }
  publish(locale, ctx, 'the hero copy could not be republished')

  return () => {
    const owner = locale[PATCH_KEY]
    if (owner === undefined || owner.original !== original) return
    locale.translate = original
    delete locale[PATCH_KEY]
    publish(locale, ctx, 'the restored hero copy could not be republished')
  }
}

/**
 * Client plugin body.
 *
 * @param ctx - client root context.
 */
export function apply(ctx) {
  ctx.effect(() => patchHeroCopy(ctx), `${ID}: hero copy`)

  // `inject` runs the callback only while the slot exists, and disposing the
  // effect releases the occupant if this plugin is ever unloaded.
  ctx.effect(
    () => ctx.slots.inject(HERO_MARK_SLOT, () => ctx.slots.register({ name: HERO_MARK_SLOT }, BrandMark)),
    `${ID}: hero brand mark`,
  )
}
