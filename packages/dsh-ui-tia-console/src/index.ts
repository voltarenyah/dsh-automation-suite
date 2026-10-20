/**
 * Host half of the plugin: the Loader row exists so the browser half has a
 * package to arrive under. Everything the console does happens in the page
 * (`src/client/`), which reads the session's own event window through the
 * `sessions` service — no host service, no TIA polling, no model messages.
 *
 * @module dsh-ui-tia-console
 */

/** Cordis plugin name, kept in step with the row id in `cordis.patch.yml`. */
export const name = 'ui-tia-console'

/** Loader-visible no-op body; the browser half carries the feature. */
export function apply(): void {}
