# Desktop installer screenshots

Screenshots of the **0.2.3** desktop setup (`dsh-automation-suite-setup-0.2.3.exe`,
Windows 11, 100 % scaling for the dialogs / 200 % for the shell) and of the shell
that opens afterwards. They are used by the **Get Started** page
(`site/get-started/index.html`, section 02) and are meant to be reused by other
documents — `docs/desktop-packaging.md`, release notes, the repository README.

Palette: the setup dialogs are Inno Setup's stock "modern" wizard, English only
(the installer ships `[Languages] english`). The shell screenshots follow the
app's own theme and language settings.

## Files

| File | Size | What it shows |
| --- | --- | --- |
| `setup-1-smartscreen.png` | 1385×898 | SmartScreen “Windows protected your PC”, collapsed — only “Don’t run” is visible |
| `setup-2-smartscreen-more-info.png` | 1386×901 | Same dialog after “More info”: app name, “Unknown publisher”, “Run anyway” |
| `setup-3-welcome.png` | 997×767 | Wizard welcome page, version 0.2.3 |
| `setup-4-destination.png` | 995×766 | Destination page, `%LOCALAPPDATA%\dsh-automation-suite`, “217.8 MB of free disk space” |
| `setup-5-tasks.png` | 997×766 | Additional tasks: “Create a desktop shortcut” |
| `setup-6-finish.png` | 994×768 | Completing page with “Launch DSH Automation Suite” checked |
| `app-light-en.webp` | 1600×962 | Shell after setup — light theme, English UI |
| `app-dark-en.webp` | 1600×962 | Shell — dark theme, English UI |
| `app-dark-zh.webp` | 1600×962 | Shell — dark theme, Chinese UI |
| `app-session-versions.webp` | 1600×962 | A running session: chat with tool calls and to-dos, **Versions** panel with two commits and per-block change badges |
| `app-dark-subagent.webp` | 1600×961 | A subagent assigned mid-session: the parent chat (prompt, summary, to-dos) on the left and the subagent's own transcript pane on the right — dark theme (not used by the page yet) |
| `app-light-zh.webp` | 1600×962 | Shell — light theme, Chinese UI (not used by the page yet) |

The app screenshots were captured from the window as it opens on a fresh
profile: sidebar, home hero (`dsh-automation-suite` / `TIA-V17`) and the five
suite tabs on the start page, with two sample workspaces registered. The
session shot is from a real project and therefore shows its workspace names,
session title, block paths and commit messages — the same project the repository
docs already refer to. No API key, token or credential is visible in any of
them.

## Using them

- From a site subpage: `../assets/images/desktop/setup-3-welcome.png`
- From a repository document: `../site/assets/images/desktop/setup-3-welcome.png`
  (or the absolute GitHub raw URL).

Keep the intrinsic `width`/`height` attributes when embedding: they reserve the
box before the image loads. The page renders dialogs at ≤ 720 px and the shell
at container width, so both stay sharp on HiDPI displays.

## Regenerating

Re-capture with the Snipping Tool or `Alt`+`Print Screen`, crop to the window,
then optimise (the dialogs are lossless PNG, the shell is WebP q88 after a
Lanczos resize to 1600 px wide):

```powershell
& "$env:LOCALAPPDATA\Programs\Python\Python313\python.exe" -X utf8 -c @"
from PIL import Image
im = Image.open(src).convert('RGB')
im.save(dst, 'PNG', optimize=True)          # dialogs
# im.resize((1600, round(im.height * 1600 / im.width)), Image.LANCZOS).save(dst, 'WEBP', quality=88, method=6)
"@
```

The German/French etc. wizard pages do not exist: the installer is English only,
so a localised walkthrough has to translate the captions, not the screenshots.
