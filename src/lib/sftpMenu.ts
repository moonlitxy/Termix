import type { SftpItem } from "../types";

/** SFTP 文件列表右键菜单项定义 */
export interface SftpMenuItem {
  id: "download" | "upload" | "rename" | "delete" | "copyPath" | "mkdir" | "refresh";
  label: string;
  icon: string;
  dangerous?: boolean;
  dividerBefore?: boolean;
}

/**
 * 根据侧栏与选中项决定 SFTP 右键菜单项。
 * - 远程文件：下载 / 重命名 / 删除 / 复制路径
 * - 本地文件：上传 / 复制路径
 * - 远程空白：新建文件夹 / 刷新
 * - 本地空白：刷新
 */
export function sftpContextMenu(
  side: "remote" | "local",
  item: SftpItem | null
): SftpMenuItem[] {
  if (item) {
    const items: SftpMenuItem[] = [];
    if (side === "remote") {
      items.push(
        {
          id: "download",
          label: item.isDir ? "下载目录" : "下载",
          icon: "download",
        },
        { id: "rename", label: "重命名", icon: "edit" },
        { id: "delete", label: "删除", icon: "trash", dangerous: true },
        { id: "copyPath", label: "复制路径", icon: "copy", dividerBefore: true }
      );
    } else {
      items.push(
        { id: "upload", label: item.isDir ? "上传目录" : "上传", icon: "upload" },
        { id: "copyPath", label: "复制路径", icon: "copy" }
      );
    }
    items.push({ id: "refresh", label: "刷新", icon: "refresh", dividerBefore: true });
    return items;
  }
  // 空白区域
  const items: SftpMenuItem[] = [];
  if (side === "remote") {
    items.push({ id: "mkdir", label: "新建文件夹", icon: "plus" });
  }
  items.push({
    id: "refresh",
    label: "刷新",
    icon: "refresh",
    dividerBefore: items.length > 0,
  });
  return items;
}
