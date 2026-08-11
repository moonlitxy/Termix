// 共享应用设置（localStorage 持久化）
// 修改后统一派发 termix-settings-change 事件，供轮询组件动态调整。

export interface Settings {
  theme: "dark" | "light" | "system";
  fontSize: number;
  cursorStyle: "block" | "underline" | "bar";
  scrollback: number;
  monitorInterval: number; // 监控刷新间隔（毫秒）
}

export const SETTINGS_KEY = "termix.settings";
export const SETTINGS_CHANGE_EVENT = "termix-settings-change";

export const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  fontSize: 13,
  cursorStyle: "block",
  scrollback: 5000,
  monitorInterval: 2000,
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: Settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  window.dispatchEvent(new Event(SETTINGS_CHANGE_EVENT));
}
