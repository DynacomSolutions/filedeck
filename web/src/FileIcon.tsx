import { File, FileImage, FileVideo, Folder, Link } from "lucide-react";

/** Flat line icon for a directory entry (replaces the folder/file/link emoji). */
export function FileIcon({ type, dir, kind, className }: { type?: string; dir?: boolean; kind?: string | null; className?: string }) {
  const Cmp = dir || type === "dir" ? Folder : type === "symlink" ? Link : kind === "video" ? FileVideo : kind ? FileImage : File;
  return <Cmp className={className} aria-hidden="true" />;
}
