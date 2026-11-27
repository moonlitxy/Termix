import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callbacks: [] as Array<(e: { tabId: string; data: string }) => void>,
  unlisten: vi.fn(),
}));

vi.mock("../ipc", () => ({
  onTerminalOutput: vi.fn(
    async (cb: (e: { tabId: string; data: string }) => void) => {
      mocks.callbacks.push(cb);
      return mocks.unlisten;
    }
  ),
}));

describe("terminalOutput", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.callbacks.length = 0;
    mocks.unlisten.mockClear();
  });

  it("按 tabId 分发，退订后不再收到", async () => {
    const { subscribeTerminalOutput } = await import("../terminalOutput");
    const a = vi.fn();
    const b = vi.fn();

    const offA = subscribeTerminalOutput("tab-a", a);
    const offB = subscribeTerminalOutput("tab-b", b);
    await vi.waitFor(() => expect(mocks.callbacks).toHaveLength(1));

    mocks.callbacks[0]({ tabId: "tab-a", data: "x" });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();

    mocks.callbacks[0]({ tabId: "tab-b", data: "y" });
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledTimes(1);

    offA();
    mocks.callbacks[0]({ tabId: "tab-a", data: "z" });
    expect(a).toHaveBeenCalledTimes(1);
    offB();
  });

  it("最后一个订阅者退订后取消底层监听", async () => {
    const { subscribeTerminalOutput } = await import("../terminalOutput");
    const off = subscribeTerminalOutput("tab", vi.fn());
    await vi.waitFor(() => expect(mocks.callbacks).toHaveLength(1));

    off();
    expect(mocks.unlisten).toHaveBeenCalledTimes(1);
  });
});
