/**
 * Host half of the plugin.
 *
 * The plugin is presentation-only: its node half exists so Loader has a bundle
 * row to enable, while all behaviour ships in `lib/client.js`. This mirrors the
 * official brand plugin, whose empty `apply` is documented for the same reason.
 *
 * @module dsh-ui-brandmark
 */

/** Host plugin body — this package contributes browser presentation only. */
export function apply(): void {}
