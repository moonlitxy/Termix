import { afterEach, describe, expect, it, vi } from "vitest";
import { backendError, getLang, i18nKeys, t } from "../i18n";
import { SETTINGS_KEY } from "../settings";

function stubStorage(lang?: "zh" | "en") {
  const values = new Map<string, string>();
  if (lang) values.set(SETTINGS_KEY, JSON.stringify({ lang }));
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => void values.set(k, v),
    removeItem: (k: string) => void values.delete(k),
    clear: () => values.clear(),
  });
}

describe("i18n 国际化", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("默认中文，设置为 en 后切换", () => {
    stubStorage();
    expect(getLang()).toBe("zh");
    stubStorage("en");
    expect(getLang()).toBe("en");
  });

  it("设置读取异常时回退中文", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => "{bad json",
      setItem: () => {},
    });
    expect(getLang()).toBe("zh");
  });

  it("按语言返回对应文案并支持插值", () => {
    stubStorage("zh");
    expect(t("common.cancel")).toBe("取消");
    expect(t("statusbar.broadcastOn", { n: 3 })).toContain("3");
    stubStorage("en");
    expect(t("common.cancel")).toBe("Cancel");
    expect(t("statusbar.broadcastOn", { n: 3 })).toContain("3");
  });

  it("未知 key 原样返回", () => {
    stubStorage("en");
    expect(t("no.such.key")).toBe("no.such.key");
  });

  it("中英字典键完全对齐", () => {
    const zhKeys = i18nKeys("zh").sort();
    const enKeys = i18nKeys("en").sort();
    expect(enKeys).toEqual(zhKeys);
  });

  it("后端高频错误在英文下翻译，中文下保持原文", () => {
    stubStorage("en");
    expect(backendError("authentication failed")).toContain("Authentication failed");
    expect(backendError("跳板机不能是自身")).toContain("Jump host cannot be itself");
    // 未命中映射时保留原文
    expect(backendError("some raw error")).toBe("some raw error");
    stubStorage("zh");
    expect(backendError("authentication failed")).toBe("authentication failed");
  });
});
