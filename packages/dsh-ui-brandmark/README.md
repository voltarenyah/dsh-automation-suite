# dsh-ui-brandmark

Home-page hero branding for the **dsh-automation-suite** desktop distribution.

DSH's conversation client owns the landing hero and hard-codes its i18n strings
(`conversation` namespace: `hero.headline` = *Into the Unknown* / 探索未至之境,
`hero.preview` = *Preview* / 预览版). The official brand plugin deliberately
leaves the hero alone, and no Loader config renames it. This plugin replaces
those three visual pieces without touching `app.asar`:

| Hero piece | Before | After |
|---|---|---|
| headline | Into the Unknown / 探索未至之境 | `dsh-automation-suite` |
| preview badge | Preview / 预览版 | `TIA-V17` |
| mark | animated whale fish (fallback) | the desktop shell's app icon (`desktop/DshSuite.Shell/app.ico`, 128 px PNG) |

## How it hooks in

- **Copy**: the browser half wraps the client locale service's `translate` and
  answers only the two `conversation` keys; every other lookup (other keys, the
  `common` namespace, future strings) falls through to the real dictionary. A
  `publish` after installing and after removing the wrapper re-renders the
  locale subscribers, so the change shows without a reload.
- **Mark**: `conversation.hero.brand.mark` is a declared single slot whose
  fallback is the fish; registering `BrandMark` for it replaces the fallback.
- Both are registered through `ctx.effect`, so unloading the plugin restores the
  stock hero. Failures are logged and never break the page.

The two strings are constants in `src/model.ts` (`HERO_HEADLINE`,
`HERO_PREVIEW`); change them there and rebuild. The icon is
`assets/brandmark.png`, inlined into the bundle as a data URL at build time.

## Build, test, install

```powershell
node scripts\build.mjs      # lib/index.js, lib/model.js, lib/client.js
node scripts\run-tests.mjs  # builds, then node:test
```

Inside this repository the plugin is deployed by the blueprint
(`profile/dsh-automation-suite/package.json` → `dsh.profile.bundles`), so
`pwsh -NoProfile -File scripts\start-env.ps1` links and loads it automatically.
Standalone: `dsh plugin --profile <profile> add <tarball-or-package>`.

## Boundaries

- The copy override uses the client locale runtime's `translate`/`publish`
  methods. They are stable in DSH 0.2.1-rc.2 but are not a documented extension
  API; if a future DSH renames them the plugin warns and leaves the stock hero
  in place (no crash).
- The headline/badge are replaced in **both** locales on purpose: this is
  product branding, not a translation.
