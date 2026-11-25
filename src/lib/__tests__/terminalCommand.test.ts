import { describe, expect, it } from "vitest";
import { createTerminalCommandTracker } from "../terminalCommand";

describe("终端命令跟踪", () => {
  it("普通输入在回车时生成命令", () => {
    const tracker = createTerminalCommandTracker();
    expect(tracker.feed("cd /opt", () => null)).toEqual([]);
    expect(tracker.feed("\r", () => null)).toEqual(["cd /opt"]);
  });

  it("Tab 补全后从终端缓冲回退提取", () => {
    const tracker = createTerminalCommandTracker();
    tracker.feed("cd /op\t", () => null);
    expect(tracker.feed("\r", () => "cd /opt")).toEqual(["cd /opt"]);
  });

  it("历史上下键后从终端缓冲回退提取", () => {
    const tracker = createTerminalCommandTracker();
    tracker.feed("\x1b[A", () => null);
    expect(tracker.feed("\r", () => "cd /var/log")).toEqual(["cd /var/log"]);
  });

  it("Ctrl+U / Ctrl+W / 退格会修改当前行", () => {
    const clear = createTerminalCommandTracker();
    expect(clear.feed("garbage\u0015cd /good\r", () => null)).toEqual([
      "cd /good",
    ]);

    const erase = createTerminalCommandTracker();
    expect(erase.feed("cd /optxxx\b\b\b\r", () => null)).toEqual(["cd /opt"]);

    const removeWord = createTerminalCommandTracker();
    expect(removeWord.feed("cd /opt extra\u0017\r", () => null)).toEqual([
      "cd /opt",
    ]);
  });

  it("一次数据块包含多行时返回多条命令", () => {
    const tracker = createTerminalCommandTracker();
    expect(tracker.feed("cd /a\rcd /b\n", () => null)).toEqual([
      "cd /a",
      "cd /b",
    ]);
  });
});
