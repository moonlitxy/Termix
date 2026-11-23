// 共享应用设置（localStorage 持久化）
// 修改后统一派发 termix-settings-change 事件，供轮询组件动态调整。

import type { Lang } from "./i18n";

export type FontFamilyId = "system" | "pingfang" | "sourceHan" | "wenkai" | "song" | "mono";

export const FONT_FAMILIES: { id: FontFamilyId; labelKey: string }[] = [
  { id: "system", labelKey: "st.font.system" },
  { id: "pingfang", labelKey: "st.font.pingfang" },
  { id: "sourceHan", labelKey: "st.font.sourceHan" },
  { id: "wenkai", labelKey: "st.font.wenkai" },
  { id: "song", labelKey: "st.font.song" },
  { id: "mono", labelKey: "st.font.mono" },
];

const FONT_STACKS: Record<FontFamilyId, string> = {
  system:
    '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Helvetica Neue", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", sans-serif',
  pingfang:
    '"PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif',
  sourceHan:
    '"Source Han Sans SC", "Noto Sans CJK SC", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',
  wenkai:
    '"LXGW WenKai", "LXGW WenKai Screen", "Kaiti SC", "KaiTi", "STKaiti", "PingFang SC", "Microsoft YaHei", sans-serif',
  song:
    '"Songti SC", "Noto Serif SC", "Noto Serif CJK SC", "SimSun", "PingFang SC", serif',
  mono:
    'ui-monospace, "SF Mono", Menlo, Monaco, Consolas, "Cascadia Code", "JetBrains Mono", monospace',
};

export interface Settings {
  theme: "dark" | "light";
  /** 界面字体：默认沿用当前系统字体栈 */
  fontFamily: FontFamilyId;
  fontSize: number;
  cursorStyle: "block" | "underline" | "bar";
  scrollback: number;
  monitorInterval: number; // 监控刷新间隔（毫秒）
  sftpPanelRatio: number; // 文件面板占工作区高度的比例（0-1）
  rightPanelExpanded: boolean;
  /** 悬浮传输窗口是否展开（用户手动开关的持久偏好） */
  transferWindowOpen: boolean;
  sftpCollapsed: boolean;
  lastLocalPath: string;
  /** 软件更新通道：direct 直连（默认）/ mirror 镜像加速 / proxy 代理 */
  updateMode: "direct" | "mirror" | "proxy";
  /** 选中的内置镜像 id，或 "custom" 走自定义镜像 */
  updateMirror: string;
  /** 自定义镜像基址，如 https://gh-proxy.com/ */
  customMirror: string;
  /** 代理地址，如 http://127.0.0.1:7890（代理模式必填） */
  updateProxy: string;
  /** 同步输入：终端输入同时写到其他已连接标签（含分屏） */
  broadcastInput: boolean;
  /** 界面语言：zh 中文（默认）/ en English */
  lang: Lang;
}

export const SETTINGS_KEY = "termix.settings";
export const SETTINGS_CHANGE_EVENT = "termix-settings-change";

export const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  fontFamily: "system",
  fontSize: 13,
  cursorStyle: "block",
  scrollback: 5000,
  monitorInterval: 2000,
  sftpPanelRatio: 0.4,
  rightPanelExpanded: false,
  transferWindowOpen: false,
  sftpCollapsed: false,
  lastLocalPath: "",
  updateMode: "direct",
  updateMirror: "gh-proxy",
  customMirror: "",
  updateProxy: "",
  broadcastInput: false,
  lang: "zh",
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<Settings> & { theme?: string };
    // 旧版本曾提供「跟随系统」；为保证默认深色，迁移为明确深色。
    const theme: Settings["theme"] = parsed.theme === "light" ? "light" : "dark";
    return { ...DEFAULT_SETTINGS, ...parsed, theme };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: Settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  window.dispatchEvent(new Event(SETTINGS_CHANGE_EVENT));
}

/** Apply startup-safe appearance before React mounts, then reuse for live setting changes. */
export function applyAppearance(settings: Settings = loadSettings()) {
  const root = document.documentElement;
  root.dataset.theme = settings.theme;
  root.style.colorScheme = settings.theme;

  const ui = (n: number) => `clamp(${n}px, calc(${n}px + 0.15vw), ${n + 4}px)`;
  root.style.setProperty("--body-xs-font-size", ui(settings.fontSize - 3));
  root.style.setProperty("--body-sm-font-size", ui(settings.fontSize - 2));
  root.style.setProperty("--body-md-font-size", ui(settings.fontSize - 1));
  root.style.setProperty("--body-base-font-size", ui(settings.fontSize));
  root.style.setProperty("--code-terminal-font-size", ui(settings.fontSize - 1));
  const fontStack = FONT_STACKS[settings.fontFamily] ?? FONT_STACKS.system;
  root.style.setProperty("--font-family-default", fontStack);
  root.style.setProperty("--font-family-heading", fontStack);
}
