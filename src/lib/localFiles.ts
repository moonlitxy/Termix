import type { SftpItem } from "../types";

/** 本地文件列表：目录优先，其次按名称大小写不敏感排序。 */
export function sortLocalItems(items: SftpItem[]): SftpItem[] {
  return [...items].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

/** 按文件名过滤本地列表；查询为空时返回原列表。 */
export function filterLocalItems(items: SftpItem[], query: string): SftpItem[] {
  const keyword = query.trim().toLowerCase();
  if (!keyword) return items;
  return items.filter((item) => item.name.toLowerCase().includes(keyword));
}
