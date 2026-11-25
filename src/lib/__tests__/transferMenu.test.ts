import { describe, expect, it } from "vitest";
import { transferMenuActions } from "../transferMenu";
import type { TransferTask } from "../../types";

function task(patch: Partial<TransferTask>): TransferTask {
  return {
    id: "task-1",
    sessionId: "session-1",
    connectionId: "conn-1",
    fileName: "file.txt",
    direction: "download",
    localPath: "/Users/mac/Downloads/file.txt",
    remotePath: "/tmp/file.txt",
    status: "completed",
    progress: 100,
    speed: 0,
    transferredBytes: 1,
    totalBytes: 1,
    isDir: false,
    createdAt: 1,
    ...patch,
  };
}

describe("传输完成项右键菜单", () => {
  it("下载完成项提供在文件夹中显示", () => {
    expect(transferMenuActions(task({ direction: "download" }))).toEqual([
      "revealLocal",
    ]);
  });

  it("上传完成项提供复制服务器路径", () => {
    expect(transferMenuActions(task({ direction: "upload" }))).toEqual([
      "copyRemotePath",
    ]);
  });

  it("传输未完成时不提供右键操作", () => {
    expect(
      transferMenuActions(task({ direction: "download", status: "running" }))
    ).toEqual([]);
    expect(
      transferMenuActions(task({ direction: "upload", status: "failed" }))
    ).toEqual([]);
  });
});
