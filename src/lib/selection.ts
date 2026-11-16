export interface PathItem {
  path: string;
}

export function toggleSelection(paths: string[], path: string): string[] {
  return paths.includes(path)
    ? paths.filter((value) => value !== path)
    : [...paths, path];
}

export function rangeSelection<T extends PathItem>(
  items: T[],
  anchorPath: string | null,
  targetPath: string
): string[] {
  if (!anchorPath) return [targetPath];
  const anchor = items.findIndex((item) => item.path === anchorPath);
  const target = items.findIndex((item) => item.path === targetPath);
  if (anchor < 0 || target < 0) return [targetPath];
  const start = Math.min(anchor, target);
  const end = Math.max(anchor, target);
  return items.slice(start, end + 1).map((item) => item.path);
}

export function selectAllPaths<T extends PathItem>(items: T[]): string[] {
  return items.map((item) => item.path);
}
