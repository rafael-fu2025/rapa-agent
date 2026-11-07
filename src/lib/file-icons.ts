// File-type icon resolver for workspace file trees.
//
// Assets are the vendored Material Icon Theme subset in
// src/assets/file-icons (92 SVGs + mapping.json — see that folder's README
// for provenance and the MIT license). Resolution mirrors the VS Code
// theme: an exact file-name match ("package.json" → npm) wins over a
// dotted-suffix extension match ("app.module.ts" → angular), and anything
// unmatched falls back to the generic `file` icon. Folders resolve through
// the theme's folderNames / folderNamesExpanded lists with the plain
// folder icons as fallback.
//
// Like provider-icons.ts, assets are imported through ESM so Vite hashes +
// emits them — runtime string paths 404'd in production builds (audit M3).

import mappingJson from "../assets/file-icons/mapping.json";
import fileFallback from "../assets/file-icons/file.svg";
import folderFallback from "../assets/file-icons/folder.svg";
import folderOpenFallback from "../assets/file-icons/folder-open.svg";

type IconMappingEntry = {
  fileExtensions: string[];
  fileNames: string[];
  languageIds: string[];
  folderNames?: string[];
  folderNamesExpanded?: string[];
};

const mapping = mappingJson as Record<string, IconMappingEntry>;

// Icon name → hashed asset URL, keyed off the glob path
// ("../assets/file-icons/json.svg" → "json").
const ASSET_URLS = import.meta.glob<string>("../assets/file-icons/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
});

const ICONS: Record<string, string> = {};
for (const [path, url] of Object.entries(ASSET_URLS)) {
  const name = path.slice(path.lastIndexOf("/") + 1).replace(/\.svg$/, "");
  ICONS[name] = url;
}

// File names whose theme mapping lives outside the vendored subset —
// without this, "go.mod" falls through to the audio "mod" module
// extension instead of the Go icon.
const FILE_NAME_OVERRIDES: Record<string, string> = {
  "go.mod": "go",
  "go.sum": "go",
  "go.work": "go",
};

// Exact file names ("package.json", ".gitignore") → icon.
const FILE_NAME_ICONS: Record<string, string> = {};
// File extensions, including compound ones ("module.ts") → icon.
const EXTENSION_ICONS: Record<string, string> = {};
// Folder names → closed / expanded icon.
const FOLDER_ICONS: Record<string, string> = {};
const FOLDER_OPEN_ICONS: Record<string, string> = {};

for (const [icon, entry] of Object.entries(mapping)) {
  for (const fileName of entry.fileNames) {
    FILE_NAME_ICONS[fileName.toLowerCase()] = icon;
  }
  for (const ext of entry.fileExtensions) {
    EXTENSION_ICONS[ext.toLowerCase()] = icon;
  }
  for (const folder of entry.folderNames ?? []) {
    FOLDER_ICONS[folder.toLowerCase()] = icon;
  }
  for (const folder of entry.folderNamesExpanded ?? []) {
    FOLDER_OPEN_ICONS[folder.toLowerCase()] = icon;
  }
}
Object.assign(FILE_NAME_ICONS, FILE_NAME_OVERRIDES);

// Suffix match on the extension — longest first, so "app.module.ts" hits
// the compound "module.ts" entry before the plain "ts" one.
function lookupFileIcon(fileName: string): string | undefined {
  const name = fileName.toLowerCase();
  const byName = FILE_NAME_ICONS[name];
  if (byName) return byName;
  let dot = name.indexOf(".");
  while (dot !== -1) {
    const icon = EXTENSION_ICONS[name.slice(dot + 1)];
    if (icon) return icon;
    dot = name.indexOf(".", dot + 1);
  }
  return undefined;
}

export function getFileIconPath(fileName: string): string {
  return ICONS[lookupFileIcon(fileName) ?? "file"] ?? fileFallback;
}

export function getFolderIconPath(folderName: string, open: boolean): string {
  const icon = open
    ? FOLDER_OPEN_ICONS[folderName.toLowerCase()] ?? "folder-open"
    : FOLDER_ICONS[folderName.toLowerCase()] ?? "folder";
  return ICONS[icon] ?? (open ? folderOpenFallback : folderFallback);
}
