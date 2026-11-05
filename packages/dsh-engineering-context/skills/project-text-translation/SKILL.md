---
name: project-text-translation
description: Translate TIA project texts (block/network/tag/UDT comments, titles, HMI/alarm texts) through the official project-texts XLSX. Use when the user asks to translate a TIA project or fill a target project language. Plan first, translate the generated jobs in batches, then apply; verify coverage and Comments-only fingerprints, and recommend a git commit.
---

# Project text translation

Use `project_translate` for the whole workflow. It talks to TIA only through
`projectTextAccess`; it never edits code and never activates a language silently.

## 1. Ask for the inputs

Required: `target_language` (e.g. `zh-CN`), and the scope if the user did not
name one. Optional: `source_languages` (default: the project reference language;
more than one enables an optional merge), `scope` (`plc-comments` default,
`plc-all`, `hmi-user-texts`, `all-user-texts`), `target_policy`
(`only_empty` default, `overwrite`, `fill_empty_keep_existing`), glossary.

If the target is not active, `project_translate` returns
`target_language_inactive`. **Ask the user for permission**, then activate it
with the TIA `project_languages` tool (`action=set`, `active_mode=add`); never do
this without permission. F blocks are excluded by `programmingLanguage=F_*`.

## 2. Plan and let the user confirm the scope

```jsonc
project_translate({
  "action": "plan",
  "target_language": "zh-CN",
  "source_languages": ["en-GB"],
  "scope": "plc-comments"
})
```

Read the returned counts and preview. If the counts are wrong, refine
`categories` / `path_prefix` / `block_names` / `text_types` / `target_policy`
and run `plan` again. Do not translate before the user confirms.

Artifacts are under `translations/<project>/<timestamp>/`: `plan.json`,
`selected.jsonl`, `excluded.jsonl`, `jobs.jsonl`, `unique.jsonl`.

## 3. Translate

Read `unique.jsonl` (deduplicated) in batches of 50–100. For each entry, translate
`source` into the target language using `text_type`, `category`, `view_path` and
the glossary; preserve newlines, placeholders (`@1%`, `%s`, `{}`), identifiers
and numbers. Do not translate `---` separators, block/tag names, or pure numbers.

Write `translations.jsonl` as one JSON object per line:

```jsonc
{"text_id": "…", "target": "启动电机"}
```

`text_id` is the dedupe key; `row` may be used instead. Run the batch through
`text_id` validation; never invent IDs.

## 4. Apply (import + verify)

```jsonc
project_translate({
  "action": "apply",
  "target_language": "zh-CN",
  "plan_file": "…/plan.json",
  "translations_file": "…/translations.jsonl",
  "archive": true,
  "save": false
})
```

The tool archives first (non-transactional import), keeps **only the selected rows**
in the import workbook, imports, re-exports, and compares block fingerprints.
`state=Warning` is normal: TIA reports “version property is missing” for a
generated subset, and a full export would report every read-only object. Check
that `Error=0`, `coverage.translated` matches `coverage.selected`, and:
- `coverage.translated` should be close to `coverage.selected`;
- `fingerprints.Code` and `fingerprints.Interface` must be empty;
  `Comments` is the expected change; `Properties` may change due to ModifiedDate;
- if `codeChanged` is true, **do not save**: restore the archive and investigate.

Only after verification, call the TIA `save_project` tool (it is the project-saving
path; `project_translate` never saves on its own) and report the saved path.
Do not call `apply` again just to save: that would re-import.

## 5. Strongly recommend a git commit

After a successful save, tell the user to commit. If the repository tracks the
source tree (`source/`), run `project_sync` and then `project_commit` with a
message such as `i18n(zh-CN): translate project texts (N rows, plc-comments)`.
If it tracks the `.ap17` binary, use `git add <project>.ap17` and a commit
message. Do not auto-commit without the user's confirmation. Exclude
`translations/` artifacts, `tia/` and logs unless the repository policy says
otherwise.

## Failure rules

- `target_language_inactive` → ask permission, activate, re-plan.
- plan count mismatch → adjust filters; do not import.
- translation validation failure → fix the batch; do not import.
- import `Error` / large `Warning` → stop, report the archive, restore before retry.
- `Code`/`Interface` fingerprint change → stop, restore, investigate.
- Never translate F blocks; never edit `Internal ID`, source columns or `ref=` columns.
