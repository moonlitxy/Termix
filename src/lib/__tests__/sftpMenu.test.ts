import { describe, expect, it } from "vitest";
import { sftpContextMenu } from "../sftpMenu";
import type { SftpItem } from "../../types";

function item(isDir: boolean, name = "x"): SftpItem {
  return { name, path: "/home/" + name, isDir, size: isDir ? 0 : 1024, mtime: 0 };
}

describe("sftpContextMenu", () => {
  it("远程文件：下载/重命名/删除/复制路径/刷新", () => {
    const items = sftpContextMenu("remote", item(false));
    expect(items.map((i) => i.id)).toEqual([
      "download",
      "rename",
      "delete",
      "copyPath",
      "refresh",
    ]);
    expect(items[0].label).toBe("下载");
    expect(items[2].dangerous).toBe(true);
    expect(items[3].dividerBefore).toBe(true);
  });

  it("远程目录：显示「下载目录」", () => {
    const items = sftpContextMenu("remote", item(true, "logs"));
    expect(items[0].id).toBe("download");
    expect(items[0].label).toBe("下载目录");
  });

  it("本地文件：上传/复制路径/刷新", () => {
    const items = sftpContextMenu("local", item(false));
    expect(items.map((i) => i.id)).toEqual(["upload", "copyPath", "refresh"]);
    expect(items[0].label).toBe("上传");
  });

  it("本地目录：显示「上传目录」", () => {
    const items = sftpContextMenu("local", item(true, "dist"));
    expect(items[0].label).toBe("上传目录");
  });

  it("远程空白区：新建文件夹/刷新", () => {
    const items = sftpContextMenu("remote", null);
    expect(items.map((i) => i.id)).toEqual(["mkdir", "refresh"]);
  });

  it("本地空白区：仅刷新", () => {
    const items = sftpContextMenu("local", null);
    expect(items.map((i) => i.id)).toEqual(["refresh"]);
  });

  it("本地文件菜单不含删除/重命名（仅远程可管理）", () => {
    const items = sftpContextMenu("local", item(false));
    expect(items.some((i) => i.id === "delete")).toBe(false);
    expect(items.some((i) => i.id === "rename")).toBe(false);
  });
});
