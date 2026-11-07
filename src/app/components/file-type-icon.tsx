// Real file-type icons (Material Icon Theme subset — see
// src/assets/file-icons/README.md for provenance and license) rendered as
// <img> so the pre-colored SVGs display at any size. Used by the workspace
// file tree, command palette, presentation cards and diff/file headers.
import { cn } from "../../lib/utils";
import { getFileIconPath, getFolderIconPath } from "../../lib/file-icons";

export function FileTypeIcon({ name, className }: { name: string; className?: string }) {
  return (
    <img
      src={getFileIconPath(name)}
      alt=""
      aria-hidden="true"
      className={cn("shrink-0 object-contain", className)}
    />
  );
}

export function FolderTypeIcon({
  name,
  open,
  className
}: {
  name: string;
  open?: boolean;
  className?: string;
}) {
  return (
    <img
      src={getFolderIconPath(name, open === true)}
      alt=""
      aria-hidden="true"
      className={cn("shrink-0 object-contain", className)}
    />
  );
}
