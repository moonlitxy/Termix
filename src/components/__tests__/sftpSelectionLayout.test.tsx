import { describe, expect, it } from "vitest";
// @ts-ignore 缺少 @types/node 时仍可在 vitest node 环境运行
import { readFileSync } from "node:fs";
// @ts-ignore 缺少 @types/node 时仍可在 vitest node 环境运行
import { join } from "node:path";

/**
 * 页面交互回归：单击选中文件/文件夹后，顶部不再出现选择条，
 * 列表不再整体下移，双击不会点错进入错误的目录。
 * 批量操作保留在右键菜单与底部提示区。
 */
describe("SftpView 选中布局回归", () => {
  // @ts-ignore vitest node 环境提供 process
  const src: string = readFileSync(join(process.cwd(), "src/components/SftpView.tsx"), "utf-8");

  it("顶部不再渲染会推动列表的选择条", () => {
    expect(src).not.toContain('<div className="sftp-batchbar"');
  });

  it("已选数量只显示在底部提示区", () => {
    expect(src).toContain("selectionHint(selectedPaths.length, tr)");
    expect(src).toContain("sftp-pane__hint");
  });

  it("后台补充目录大小时不重算列宽", () => {
    expect(src).toContain("shouldAutoFit");
    expect(src).toContain("autoFitKeyRef");
  });

  it("批量下载/复制/删除仍可通过右键菜单触发", () => {
    expect(src).toContain("downloadSelected");
    expect(src).toContain("copySelectedPaths");
    expect(src).toContain("deleteSelected");
  });
});
