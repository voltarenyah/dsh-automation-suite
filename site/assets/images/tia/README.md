# TIA Portal screenshots

Screenshots of TIA Portal as this distribution actually uses it. They are not
installer screens — the desktop installer and shell shots live in
`site/assets/images/desktop/`.

## Files

| File | Size | What it shows |
| --- | --- | --- |
| `openness-access-dialog.webp` | 888×513 | Crop of the `Openness access (0033:000666)` dialog: TIA asks whether `TiaOpennessV17Min.Controller.exe` (full profile path + PID) may attach to the running Portal, with `Yes` / `Yes to all` / `No` |
| `openness-access.webp` | 1600×944 | The same moment in the whole Portal V17 window, for context |

Both are used by the **Get Started** page (`site/get-started/index.html`,
“First TIA call” note in section 04). The dialog is shown cropped inline
(legible at reading size) and links to the full window.

## Facts behind the copy

- V17 asks this the first time an exe whose path/hash is not yet whitelisted
  touches the Portal — i.e. on first use, after the controller is rebuilt, and
  after an upgrade that changes the controller binary.
- `Yes` grants the current session only.
- `Yes to all` additionally writes
  `HKLM\SOFTWARE\Siemens\Automation\Openness\17.0\Whitelist\TiaOpennessV17Min.Controller.exe`,
  which needs an elevated TIA; that entry is what stops the prompt returning.
- `No` denies access: the tool call then fails and the dialog reappears on the
  next attempt.
- V18+ can require further whitelist entries; the plugin does not wire the
  official resolver's `WhitelistApp()` yet.

Source of truth: `packages/dsh-tia-openness-v17-min/README.md` §0 and
`packages/dsh-tia-openness-v17-min/docs/decisions.md` (library section, the
“rebuild → prompt → whitelist” note).

## Regenerating

Capture the whole Portal window (`Alt`+`Print Screen`), then either scale it to
1600 px wide (WebP q88) or crop around the dialog with ~90 px of margin and save
that crop at 2× (WebP q92) so it stays sharp when displayed at ~720 px.
