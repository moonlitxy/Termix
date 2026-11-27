import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appShortcutKey,
  copyShortcutKey,
  isAppShortcut,
  isZoomShortcut,
  zoomShortcutLabel,
  type ShortcutEvent,
} from "../shortcuts";

function key(partial: Partial<ShortcutEvent>): ShortcutEvent {
  return {
    key: "",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...partial,
  };
}

function useMac() {
  vi.stubGlobal("navigator", {
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    platform: "MacIntel",
  });
}

function useWindows() {
  vi.stubGlobal("navigator", {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    platform: "Win32",
  });
}

describe("平台化快捷键", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("macOS 使用 Cmd，且不抢占 Ctrl 组合键", () => {
    useMac();
    expect(appShortcutKey("T")).toBe("⌘T");
    expect(copyShortcutKey()).toBe("⌘C");
    expect(zoomShortcutLabel()).toBe("⌘ + / -");
    expect(isAppShortcut(key({ key: "t", metaKey: true }), "t")).toBe(true);
    expect(isAppShortcut(key({ key: "d", ctrlKey: true }), "d")).toBe(false);
    expect(isAppShortcut(key({ key: "t", metaKey: true, shiftKey: true }), "t")).toBe(false);
    expect(isZoomShortcut(key({ key: "=", metaKey: true }), "=")).toBe(true);
  });

  it("Windows 使用 Ctrl+Shift，裸 Ctrl 留给终端控制键", () => {
    useWindows();
    expect(appShortcutKey("T")).toBe("Ctrl+Shift+T");
    expect(copyShortcutKey()).toBe("Ctrl+C");
    expect(zoomShortcutLabel()).toBe("Ctrl + / -");
    expect(isAppShortcut(key({ key: "T", ctrlKey: true, shiftKey: true }), "t")).toBe(true);
    expect(isAppShortcut(key({ key: "d", ctrlKey: true }), "d")).toBe(false);
    expect(isAppShortcut(key({ key: "l", ctrlKey: true }), "l")).toBe(false);
    expect(isAppShortcut(key({ key: "f", ctrlKey: true }), "f")).toBe(false);
    expect(isZoomShortcut(key({ key: "=", ctrlKey: true }), "=")).toBe(true);
  });
});
