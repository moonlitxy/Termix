import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  SETTINGS_CHANGE_EVENT,
  SETTINGS_KEY,
  applyAppearance,
  loadSettings,
  saveSettings,
} from "../settings";

function installBrowserStubs() {
  const values = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    get length() {
      return values.size;
    },
  };
  const setProperty = vi.fn();
  const documentElement = {
    dataset: {} as Record<string, string>,
    style: {
      colorScheme: "",
      setProperty,
    },
  };
  const dispatchEvent = vi.fn();
  const matchMedia = vi.fn(() => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));

  vi.stubGlobal("localStorage", localStorage);
  vi.stubGlobal("window", { dispatchEvent, matchMedia });
  vi.stubGlobal("document", { documentElement });
  return { values, setProperty, documentElement, dispatchEvent, matchMedia };
}

describe("settings", () => {
  beforeEach(() => {
    installBrowserStubs();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("无本地设置时返回默认值", () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("部分设置与默认值合并", () => {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ theme: "light", fontSize: 16 })
    );
    expect(loadSettings()).toMatchObject({
      ...DEFAULT_SETTINGS,
      theme: "light",
      fontSize: 16,
    });
  });

  it("损坏的 JSON 回退默认值", () => {
    localStorage.setItem(SETTINGS_KEY, "{broken");
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("保存设置并派发变更事件", () => {
    const { dispatchEvent } = installBrowserStubs();
    saveSettings({ ...DEFAULT_SETTINGS, fontSize: 15 });
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}").fontSize).toBe(
      15
    );
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: SETTINGS_CHANGE_EVENT })
    );
  });

  it("应用浅色主题和字号变量", () => {
    const { documentElement, setProperty } = installBrowserStubs();
    applyAppearance({
      ...DEFAULT_SETTINGS,
      theme: "light",
      fontSize: 15,
    });
    expect(documentElement.dataset.theme).toBe("light");
    expect(documentElement.style.colorScheme).toBe("light");
    expect(setProperty).toHaveBeenCalledWith(
      "--code-terminal-font-size",
      expect.stringContaining("14px")
    );
  });

  it("应用界面字体变量", () => {
    const { setProperty } = installBrowserStubs();
    applyAppearance({ ...DEFAULT_SETTINGS, fontFamily: "wenkai" });
    expect(setProperty).toHaveBeenCalledWith(
      "--font-family-default",
      expect.stringContaining("LXGW WenKai")
    );
    expect(setProperty).toHaveBeenCalledWith(
      "--font-family-heading",
      expect.stringContaining("LXGW WenKai")
    );
  });

  it("旧版跟随系统设置迁移为深色", () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ theme: "system" }));
    expect(loadSettings().theme).toBe("dark");
  });

  it("用户选择浅色后下次启动仍为浅色", () => {
    const { documentElement } = installBrowserStubs();
    saveSettings({ ...DEFAULT_SETTINGS, theme: "light" });
    applyAppearance(loadSettings());
    expect(loadSettings().theme).toBe("light");
    expect(documentElement.dataset.theme).toBe("light");
  });
});
