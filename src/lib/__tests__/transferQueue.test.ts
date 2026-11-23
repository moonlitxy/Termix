import { beforeEach, describe, expect, it } from "vitest";
import { useApp } from "../../store/app";
import type { TransferTask } from "../../types";

function task(id: string, status: TransferTask["status"] = "running"): TransferTask {
  return {
    id,
    sessionId: "s1",
    fileName: `${id}.bin`,
    direction: "download",
    localPath: `/tmp/${id}.bin`,
    remotePath: `/srv/${id}.bin`,
    status,
    progress: 0,
    speed: 0,
    transferredBytes: 0,
    totalBytes: 0,
    createdAt: 100,
  };
}

describe("传输队列删除/清空事件", () => {
  beforeEach(() => {
    useApp.setState({ transfers: [] });
  });

  it("removed 只移除对应任务", () => {
    useApp.setState({ transfers: [task("a"), task("b")] });
    useApp.getState().upsertTransfer({ taskId: "a", removed: true });
    expect(useApp.getState().transfers.map((item) => item.id)).toEqual(["b"]);
  });

  it("removedAll 清空队列，并忽略清空前任务的迟到事件", () => {
    useApp.setState({ transfers: [task("a")] });
    useApp.getState().upsertTransfer({ taskId: "", removedAll: true });
    expect(useApp.getState().transfers).toEqual([]);

    useApp.getState().upsertTransfer({
      taskId: "late",
      fileName: "late.bin",
      status: "cancelled",
      createdAt: 100,
    });
    expect(useApp.getState().transfers).toEqual([]);
  });
});
