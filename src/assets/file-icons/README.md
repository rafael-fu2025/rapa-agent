# File Icons — Material Icon Theme (subset)

A curated subset of [Material Icon Theme](https://github.com/PKief/vscode-material-icon-theme)
file/folder icons for use in this project's file trees.

- **Source repo**: https://github.com/PKief/vscode-material-icon-theme
- **Package**: `material-icon-theme` (npm), version **5.40.0**
- **License**: MIT — see `LICENSE.material-icon-theme.txt` (copied verbatim from the package)
- **Copy date**: 2026-11-07
- **Copied via**: `npm pack material-icon-theme` (tarball extracted to a temp dir outside this repo)

## Contents

- `*.svg` — 92 icons, original theme icon names preserved (e.g. `react_ts.svg`, `folder-src.svg`)
- `mapping.json` — the theme-JSON entries (`fileExtensions`, `fileNames`, `languageIds`,
  and for folders `folderNames` / `folderNamesExpanded`) relevant only to the copied icons.
  Extension keys are stored without a leading `*.`; fileName keys are kept verbatim
  (including leading dots, e.g. `.gitignore`).

## Defaults / fallbacks (from the theme)

| Role | Icon name | Theme source |
|------|-----------|--------------|
| Default file icon (fallback for anything unmatched) | `file` | top-level `file` property |
| Default closed folder | `folder` | top-level `folder` property |
| Default expanded folder | `folder-open` | top-level `folderExpanded` property |
| Root folder | `folder-root` | top-level `rootFolder` property (not copied) |

In `mapping.json`, `file`, `folder` and `folder-open` have empty arrays because the theme
selects them via its top-level default properties rather than name/extension lists.

## Conventions

- Named folders come in closed/expanded pairs: `folder-src.svg` (closed) pairs with
  `folder-src-open.svg` (expanded). The `folderNames` array in the closed icon's mapping
  entry lists the folder names that select the pair; the same keys appear under
  `folderNamesExpanded` in the `-open` icon's entry (mirroring the theme's sections).
- Some wishlist names differ from the original request; the actual theme names are used:
  - React TS/TSX: `react_ts` (not `reactts`)
  - SCSS: covered by `sass` (no separate `scss` icon in the theme)
  - Shell scripts: `console` (no `shell`/`terminal` icon)
  - `.env` files: `tune` (via the `env` extension mapping)
  - CSV/Excel: `table` (no `csv`/`excel` icon)
  - INI/config/properties: `settings`
  - Executables: `exe` (no `binary` icon)
  - Generic text: `document` (`.txt`, `plaintext`)
  - Asset folders: `folder-images` (no `folder-assets` in the theme)

Not copied on purpose: light-theme variants (`*_light.svg`), `.clone.svg` duplicates,
and `folder-root`/`folder-root-open`.
