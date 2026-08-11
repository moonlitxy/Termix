import { useEffect, useState } from "react";
import { Icon } from "./Icon";

interface Settings {
  theme: "dark" | "light";
  fontSize: number;
  cursorStyle: "block" | "underline" | "bar";
  scrollback: number;
}

const KEY = "termix.settings";
const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  fontSize: 13,
  cursorStyle: "block",
  scrollback: 5000,
};

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function applyTheme(theme: string) {
  document.documentElement.setAttribute("data-theme", theme);
}

function applyFont(size: number) {
  document.documentElement.style.setProperty("--code-terminal-font-size", size + "px");
  document.documentElement.style.setProperty("--body-base-font-size", size + "px");
}

export function SettingsView() {
  const [settings, setSettings] = useState<Settings>(load);

  useEffect(() => {
    applyTheme(settings.theme);
    applyFont(settings.fontSize);
    localStorage.setItem(KEY, JSON.stringify(settings));
  }, [settings]);

  const set = (patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch }));

  return (
    <div className="st-view">
      <div className="fw-toolbar">
        <span className="fw-toolbar__title">设置</span>
      </div>
      <div className="st-body">
        <div className="ds-card st-section">
          <div className="res-card__head">
            <span className="res-card__label">
              <Icon name="settings" size={14} />通用
            </span>
          </div>
          <div className="st-row">
            <label>主题</label>
            <select
              className="ds-input st-input"
              value={settings.theme}
              onChange={(e) => set({ theme: e.target.value as Settings["theme"] })}
            >
              <option value="dark">深色</option>
              <option value="light">浅色</option>
            </select>
          </div>
          <div className="st-row">
            <label>界面字号</label>
            <input
              className="ds-input st-input"
              type="number"
              min={11}
              max={16}
              value={settings.fontSize}
              onChange={(e) => set({ fontSize: Number(e.target.value) || 13 })}
            />
          </div>
        </div>

        <div className="ds-card st-section">
          <div className="res-card__head">
            <span className="res-card__label">
              <Icon name="terminal" size={14} />终端
            </span>
          </div>
          <div className="st-row">
            <label>光标样式</label>
            <select
              className="ds-input st-input"
              value={settings.cursorStyle}
              onChange={(e) => set({ cursorStyle: e.target.value as Settings["cursorStyle"] })}
            >
              <option value="block">块状</option>
              <option value="underline">下划线</option>
              <option value="bar">竖线</option>
            </select>
          </div>
          <div className="st-row">
            <label>滚动缓冲区</label>
            <select
              className="ds-input st-input"
              value={settings.scrollback}
              onChange={(e) => set({ scrollback: Number(e.target.value) })}
            >
              <option value={1000}>1000 行</option>
              <option value={5000}>5000 行</option>
              <option value={10000}>10000 行</option>
            </select>
          </div>
        </div>

        <div className="ds-card st-section">
          <div className="res-card__head">
            <span className="res-card__label">
              <Icon name="key" size={14} />快捷键
            </span>
          </div>
          <div className="st-row">
            <label>新建会话</label>
            <span className="st-kbd">⌘ / Ctrl + T</span>
          </div>
          <div className="st-row">
            <label>断开连接</label>
            <span className="st-kbd">⌘ / Ctrl + D</span>
          </div>
          <div className="st-row">
            <label>终端字号缩放</label>
            <span className="st-kbd">Ctrl + / -</span>
          </div>
        </div>
      </div>
    </div>
  );
}
