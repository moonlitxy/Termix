import { describe, expect, it } from "vitest";
import {
  formatEta,
  isTransferActive,
  isTransferTerminal,
  transferEtaSeconds,
  transferLocation,
  transferPercent,
} from "../transfer";
import type { TransferTask } from "../../types";

function task(overrides: Partial<TransferTask> = {}): TransferTask {
  return {
    id: "t1",
    sessionId: "s1",
    fileName: "app.log",
    direction: "download",
    localPath: "/Users/mac/Downloads/app.log",
    remotePath: "/var/log/app.log",
    status: "running",
    progress: 0,
    speed: 0,
    transferredBytes: 0,
    totalBytes: 0,
    ...overrides,
  };
}

describe("传输队列辅助函数", () => {
  it("优先使用字节数计算百分比并限制在 0-100", () => {
    expect(transferPercent(task({ transferredBytes: 25, totalBytes: 100 }))).toBe(25);
    expect(transferPercent(task({ transferredBytes: 120, totalBytes: 100 }))).toBe(100);
    expect(transferPercent(task({ progress: 42 }))).toBe(42);
    expect(transferPercent(task({ progress: Number.NaN }))).toBe(0);
  });

  it("下载显示本地目录，上传显示远端目录", () => {
    expect(transferLocation(task())).toBe("/Users/mac/Downloads");
    expect(
      transferLocation(
        task({
          direction: "upload",
          localPath: "/Users/mac/app.log",
          remotePath: "/opt/termix/app.log",
        })
      )
    ).toBe("/opt/termix");
    expect(transferLocation(task({ localPath: "" }))).toBe("");
  });

  it("仅在运行中且速度有效时给出剩余时间", () => {
    const running = task({
      speed: 100,
      transferredBytes: 400,
      totalBytes: 1000,
    });
    expect(transferEtaSeconds(running)).toBe(6);
    expect(transferEtaSeconds({ ...running, status: "paused" })).toBeNull();
    expect(transferEtaSeconds({ ...running, speed: 0 })).toBeNull();
    expect(
      transferEtaSeconds({ ...running, transferredBytes: 1000 })
    ).toBeNull();
  });

  it("剩余时间格式化为 mm:ss / h:mm:ss", () => {
    expect(formatEta(5)).toBe("0:05");
    expect(formatEta(65)).toBe("1:05");
    expect(formatEta(3661)).toBe("1:01:01");
  });

  it("暂停和中断的任务保留在队列中，终态才自动移除", () => {
    expect(isTransferActive(task({ status: "running" }))).toBe(true);
    expect(isTransferActive(task({ status: "paused" }))).toBe(true);
    expect(isTransferActive(task({ status: "interrupted" }))).toBe(true);
    expect(isTransferActive(task({ status: "completed" }))).toBe(false);

    expect(isTransferTerminal(task({ status: "completed" }))).toBe(true);
    expect(isTransferTerminal(task({ status: "failed" }))).toBe(true);
    expect(isTransferTerminal(task({ status: "cancelled" }))).toBe(true);
    expect(isTransferTerminal(task({ status: "paused" }))).toBe(false);
    expect(isTransferTerminal(task({ status: "interrupted" }))).toBe(false);
  });
});
