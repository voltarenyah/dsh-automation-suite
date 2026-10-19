/**
 * Host half of the plugin: the Loader row exists so the browser half has a
 * package to arrive under. Everything the feature does happens in the page
 * (`src/client/`), so this file has no behaviour and no dependencies — which is
 * also why the package needs no hand-written `dsh-runtime.d.ts`.
 *
 * @module dsh-ui-plc-source
 */

/** Cordis plugin name, kept in step with the row id in `cordis.patch.yml`. */
export const name = 'ui-plc-source'

/** Loader-visible no-op body; the browser half carries the feature. */
export function apply(): void {}
