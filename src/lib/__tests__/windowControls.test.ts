import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
  close: vi.fn(),
  startDragging: vi.fn(),
  isMaximized: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    minimize: mocks.minimize,
    toggleMaximize: mocks.toggleMaximize,
    close: mocks.close,
    startDragging: mocks.startDragging,
    isMaximized: mocks.isMaximized,
  }),
}));

import { isWindowsPlatform, windowControls } from "../windowControls";

describe("isWindowsPlatform", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("无 navigator 时返回 false", () => {
    expect(isWindowsPlatform()).toBe(false);
  });

  it("Windows UA 返回 true", () => {
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    });
    expect(isWindowsPlatform()).toBe(true);
  });

  it("macOS UA 返回 false", () => {
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    });
    expect(isWindowsPlatform()).toBe(false);
  });

  it("缺少 UA 时按 platform 识别 Windows", () => {
    vi.stubGlobal("navigator", { userAgent: "", platform: "Win32" });
    expect(isWindowsPlatform()).toBe(true);
  });

  it("userAgentData.platform 识别 Windows", () => {
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0",
      platform: "",
      userAgentData: { platform: "Windows" },
    });
    expect(isWindowsPlatform()).toBe(true);
  });
});

describe("windowControls", () => {
  it("转发到当前窗口", () => {
    windowControls.minimize();
    windowControls.toggleMaximize();
    windowControls.close();
    windowControls.startDragging();
    windowControls.isMaximized();
    expect(mocks.minimize).toHaveBeenCalledTimes(1);
    expect(mocks.toggleMaximize).toHaveBeenCalledTimes(1);
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(mocks.startDragging).toHaveBeenCalledTimes(1);
    expect(mocks.isMaximized).toHaveBeenCalledTimes(1);
  });
});
