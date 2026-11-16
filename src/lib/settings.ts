// 共享应用设置（localStorage 持久化）
// 修改后统一派发 termix-settings-change 事件，供轮询组件动态调整。

export interface Settings {
  theme: "dark" | "light" | "system";
  fontSize: number;
  cursorStyle: "block" | "underline" | "bar";
  scrollback: number;
  monitorInterval: number; // 监控刷新间隔（毫秒）
  sftpPanelRatio: number; // 文件面板占工作区高度的比例（0-1）
  rightPanelExpanded: boolean;
  sftpCollapsed: boolean;
}

export const SETTINGS_KEY = "termix.settings";
export const SETTINGS_CHANGE_EVENT = "termix-settings-change";

export const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  fontSize: 13,
  cursorStyle: "block",
  scrollback: 5000,
  monitorInterval: 2000,
  sftpPanelRatio: 0.4,
  rightPanelExpanded: false,
  sftpCollapsed: false,
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

function resolveTheme(theme: Settings["theme"]): "dark" | "light" {
  if (theme !== "system") return theme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/** Apply startup-safe appearance before React mounts, then reuse for live setting changes. */
export function applyAppearance(settings: Settings = loadSettings()) {
  const resolved = resolveTheme(settings.theme);
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;

  const ui = (n: number) => `clamp(${n}px, calc(${n}px + 0.15vw), ${n + 4}px)`;
  root.style.setProperty("--body-xs-font-size", ui(settings.fontSize - 3));
  root.style.setProperty("--body-sm-font-size", ui(settings.fontSize - 2));
  root.style.setProperty("--body-md-font-size", ui(settings.fontSize - 1));
  root.style.setProperty("--body-base-font-size", ui(settings.fontSize));
  root.style.setProperty("--code-terminal-font-size", ui(settings.fontSize - 1));
}
