import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchAddon } from "@xterm/addon-search";
import type { Terminal } from "@xterm/xterm";
import { terminalRegistry } from "../terminalRegistry";

describe("terminalRegistry", () => {
  beforeEach(() => {
    terminalRegistry.remove("tab-a");
    terminalRegistry.remove("tab-b");
  });

  it("注册并按 tabId 获取终端与搜索实例", () => {
    const terminal = { focus: vi.fn() } as unknown as Terminal;
    const search = {} as SearchAddon;
    terminalRegistry.set("tab-a", terminal);
    terminalRegistry.setSearch("tab-a", search);

    expect(terminalRegistry.get("tab-a")).toBe(terminal);
    expect(terminalRegistry.getSearch("tab-a")).toBe(search);
  });

  it("记录最近焦点并聚焦对应终端", () => {
    const terminal = { focus: vi.fn() } as unknown as Terminal;
    terminalRegistry.set("tab-a", terminal);
    terminalRegistry.setFocus("tab-a");
    terminalRegistry.focus("tab-a");

    expect(terminalRegistry.getFocus()).toBe("tab-a");
    expect(terminal.focus).toHaveBeenCalledOnce();
  });

  it("移除标签时清理终端、搜索和焦点", () => {
    const terminal = { focus: vi.fn() } as unknown as Terminal;
    terminalRegistry.set("tab-a", terminal);
    terminalRegistry.setSearch("tab-a", {} as SearchAddon);
    terminalRegistry.setFocus("tab-a");
    terminalRegistry.remove("tab-a");

    expect(terminalRegistry.get("tab-a")).toBeUndefined();
    expect(terminalRegistry.getSearch("tab-a")).toBeUndefined();
    expect(terminalRegistry.getFocus()).toBeNull();
  });

  it("移除非当前焦点标签不会清空焦点", () => {
    terminalRegistry.setFocus("tab-a");
    terminalRegistry.remove("tab-b");
    expect(terminalRegistry.getFocus()).toBe("tab-a");
  });

  it("聚焦未注册标签时静默跳过", () => {
    expect(() => terminalRegistry.focus("missing-tab")).not.toThrow();
  });
});
