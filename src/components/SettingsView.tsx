import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { ipc } from "../lib/ipc";
import { loadSettings, saveSettings, type Settings } from "../lib/settings";
import type { MasterStatus } from "../types";

function systemTheme(): "dark" | "light" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: string) {
  document.documentElement.setAttribute(
    "data-theme",
    theme === "system" ? systemTheme() : theme
  );
}

function applyFont(size: number) {
  // 以用户字号为基准，叠加视口自适应（窗口变化时字体随之缩放）
  const ui = (n: number) => `clamp(${n}px, calc(${n}px + 0.15vw), ${n + 4}px)`;
  document.documentElement.style.setProperty("--body-xs-font-size", ui(size - 3));
  document.documentElement.style.setProperty("--body-sm-font-size", ui(size - 2));
  document.documentElement.style.setProperty("--body-md-font-size", ui(size - 1));
  document.documentElement.style.setProperty("--body-base-font-size", ui(size));
  document.documentElement.style.setProperty("--code-terminal-font-size", ui(size - 1));
}

export function SettingsView() {
  const [settings, setSettings] = useState<Settings>(loadSettings);

  useEffect(() => {
    applyTheme(settings.theme);
    applyFont(settings.fontSize);
    saveSettings(settings);
  }, [settings]);

  // 跟随系统：监听系统主题变化
  useEffect(() => {
    if (settings.theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [settings.theme]);

  const set = (patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch }));

  // ---- 安全：主密码 ----
  const [master, setMaster] = useState<MasterStatus>({ hasMaster: false, unlocked: false });
  const [newPass, setNewPass] = useState("");
  const [confirmPass, setConfirmPass] = useState("");
  const [oldPass, setOldPass] = useState("");
  const [unlockPass, setUnlockPass] = useState("");

  const refreshMaster = () => {
    ipc
      .masterStatus()
      .then(setMaster)
      .catch(() => {});
  };
  useEffect(() => {
    void refreshMaster();
  }, []);

  const doSet = async () => {
    if (newPass.length < 4) {
      window.alert("主密码至少 4 位");
      return;
    }
    if (newPass !== confirmPass) {
      window.alert("两次输入的主密码不一致");
      return;
    }
    try {
      await ipc.masterSet(newPass, master.hasMaster ? oldPass : undefined);
      setNewPass("");
      setConfirmPass("");
      setOldPass("");
      refreshMaster();
      window.alert(master.hasMaster ? "主密码已修改" : "主密码已设置，会话密码已加密");
    } catch (e) {
      window.alert(String(e));
    }
  };

  const doUnlock = async () => {
    try {
      await ipc.masterUnlock(unlockPass);
      setUnlockPass("");
      refreshMaster();
      window.alert("已解锁");
    } catch (e) {
      window.alert(String(e));
    }
  };

  const doLock = async () => {
    try {
      await ipc.masterLock();
      refreshMaster();
      window.alert("已锁定");
    } catch (e) {
      window.alert(String(e));
    }
  };

  const doClear = async () => {
    if (!window.confirm("清除主密码后，所有会话密码将恢复为明文存储，确定继续？")) return;
    try {
      await ipc.masterClear(unlockPass);
      setUnlockPass("");
      refreshMaster();
      window.alert("主密码已清除");
    } catch (e) {
      window.alert(String(e));
    }
  };

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
            <div className="seg-control" role="group" aria-label="主题">
              {(
                [
                  ["dark", "深色"],
                  ["light", "浅色"],
                  ["system", "跟随系统"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={settings.theme === value ? "is-active" : ""}
                  onClick={() => set({ theme: value })}
                >
                  {label}
                </button>
              ))}
            </div>
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
              <Icon name="bar" size={14} />监控
            </span>
          </div>
          <div className="st-row">
            <label>刷新间隔</label>
            <select
              className="ds-input st-input"
              value={settings.monitorInterval}
              onChange={(e) => set({ monitorInterval: Number(e.target.value) })}
            >
              <option value={1000}>1 秒</option>
              <option value={2000}>2 秒</option>
              <option value={5000}>5 秒</option>
            </select>
          </div>
        </div>

        <div className="ds-card st-section">
          <div className="res-card__head">
            <span className="res-card__label">
              <Icon name="key" size={14} />安全
            </span>
            {master.hasMaster && (
              <span className={"ds-tag " + (master.unlocked ? "ds-tag--success" : "ds-tag--neutral")}>
                {master.unlocked ? "已解锁" : "已锁定"}
              </span>
            )}
          </div>
          <div className="st-row">
            <label>主密码状态</label>
            <span className="st-kbd">
              {master.hasMaster ? "已设置（会话密码已加密）" : "未设置（密码明文存储）"}
            </span>
          </div>

          {master.hasMaster && !master.unlocked && (
            <>
              <div className="st-row">
                <label>解锁主密码</label>
                <input
                  className="ds-input st-input"
                  type="password"
                  value={unlockPass}
                  onChange={(e) => setUnlockPass(e.target.value)}
                  placeholder="输入主密码解锁"
                />
              </div>
              <div className="st-row">
                <label />
                <div className="st-actions">
                  <button className="ds-btn ds-btn--brand ds-btn--sm" type="button" onClick={() => void doUnlock()}>
                    解锁
                  </button>
                  <button className="ds-btn ds-btn--danger-subtle ds-btn--sm" type="button" onClick={() => void doClear()}>
                    清除主密码
                  </button>
                </div>
              </div>
            </>
          )}

          {master.hasMaster && master.unlocked && (
            <>
              <div className="st-row">
                <label>修改主密码</label>
                <div className="st-input-group">
                  <input
                    className="ds-input"
                    type="password"
                    value={oldPass}
                    onChange={(e) => setOldPass(e.target.value)}
                    placeholder="当前主密码"
                  />
                  <input
                    className="ds-input"
                    type="password"
                    value={newPass}
                    onChange={(e) => setNewPass(e.target.value)}
                    placeholder="新主密码"
                  />
                  <input
                    className="ds-input"
                    type="password"
                    value={confirmPass}
                    onChange={(e) => setConfirmPass(e.target.value)}
                    placeholder="确认新主密码"
                  />
                </div>
              </div>
              <div className="st-row">
                <label />
                <div className="st-actions">
                  <button className="ds-btn ds-btn--brand ds-btn--sm" type="button" onClick={() => void doSet()}>
                    修改
                  </button>
                  <button className="ds-btn ds-btn--secondary ds-btn--sm" type="button" onClick={() => void doLock()}>
                    锁定
                  </button>
                </div>
              </div>
            </>
          )}

          {!master.hasMaster && (
            <>
              <div className="st-row">
                <label>设置主密码</label>
                <div className="st-input-group">
                  <input
                    className="ds-input"
                    type="password"
                    value={newPass}
                    onChange={(e) => setNewPass(e.target.value)}
                    placeholder="主密码（至少 4 位）"
                  />
                  <input
                    className="ds-input"
                    type="password"
                    value={confirmPass}
                    onChange={(e) => setConfirmPass(e.target.value)}
                    placeholder="确认主密码"
                  />
                </div>
              </div>
              <div className="st-row">
                <label />
                <button className="ds-btn ds-btn--brand ds-btn--sm" type="button" onClick={() => void doSet()}>
                  设置并加密
                </button>
              </div>
            </>
          )}
          <div className="st-hint">设置主密码后，会话密码与私钥密码将使用 AES-256-GCM 加密存储，解锁后连接自动解密。</div>
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
