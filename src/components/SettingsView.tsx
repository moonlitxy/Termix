import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { ipc } from "../lib/ipc";
import {
  applyAppearance,
  loadSettings,
  saveSettings,
  type Settings,
} from "../lib/settings";
import {
  CUSTOM_MIRROR_ID,
  UPDATE_MIRRORS,
  describeUpdateEndpoint,
  normalizeMirrorBase,
  normalizeProxyUrl,
  resolveUpdateEndpoint,
} from "../lib/updateSource";
import { useUpdate } from "../store/update";
import { confirmDialog, toast } from "../store/feedback";
import type { MasterStatus } from "../types";

export function SettingsView() {
  const [settings, setSettings] = useState<Settings>(loadSettings);

  useEffect(() => {
    applyAppearance(settings);
    saveSettings(settings);
  }, [settings]);

  const set = (patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch }));

  // ---- 软件更新 ----
  const checking = useUpdate((s) => s.checking);
  const [updateMsg, setUpdateMsg] = useState<string | null>(null);

  const handleCheckUpdate = async () => {
    setUpdateMsg(null);
    const info = await useUpdate.getState().check();
    if (!info) {
      setUpdateMsg(useUpdate.getState().error ?? "检查更新失败，请稍后重试");
      return;
    }
    if (info.hasUpdate) {
      setUpdateMsg(`发现新版本 v${info.latestVersion}，正在打开更新提示`);
      useUpdate.getState().openDialog();
    } else {
      setUpdateMsg(`已是最新版本 v${info.currentVersion}`);
    }
  };

  // ---- 更新源：用当前表单值直测连通性（不经过保存也能验证） ----
  // 表单修改即自动保存，此处直接用当前表单值测试
  const handleTestUpdateEndpoint = async () => {
    setUpdateMsg(null);
    const r = resolveUpdateEndpoint(settings);
    if ("error" in r) {
      setUpdateMsg(`配置有误：${r.error}`);
      return;
    }
    setUpdateMsg("正在测试更新源连通性…");
    try {
      const info = await ipc.checkUpdate(r.mirror || null, r.proxy || null);
      setUpdateMsg(`连通正常，远端最新版本 v${info.latestVersion}`);
    } catch (e) {
      setUpdateMsg(`连接失败：${String(e)}`);
    }
  };

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
      toast.warning("主密码至少 4 位");
      return;
    }
    if (newPass !== confirmPass) {
      toast.warning("两次输入的主密码不一致");
      return;
    }
    try {
      await ipc.masterSet(newPass, master.hasMaster ? oldPass : undefined);
      setNewPass("");
      setConfirmPass("");
      setOldPass("");
      refreshMaster();
      toast.success(
        master.hasMaster ? "主密码已修改" : "主密码已设置，会话密码已加密"
      );
    } catch (e) {
      toast.error(String(e));
    }
  };

  const doUnlock = async () => {
    try {
      await ipc.masterUnlock(unlockPass);
      setUnlockPass("");
      refreshMaster();
      toast.success("已解锁");
    } catch (e) {
      toast.error(String(e));
    }
  };

  const doLock = async () => {
    try {
      await ipc.masterLock();
      refreshMaster();
      toast.success("已锁定");
    } catch (e) {
      toast.error(String(e));
    }
  };

  const doClear = async () => {
    const confirmed = await confirmDialog({
      title: "清除主密码",
      message: "清除主密码后，所有会话密码将恢复为明文存储，确定继续？",
      confirmText: "清除",
      danger: true,
    });
    if (!confirmed) return;
    try {
      await ipc.masterClear(unlockPass);
      setUnlockPass("");
      refreshMaster();
      toast.success("主密码已清除");
    } catch (e) {
      toast.error(String(e));
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
            <div className="st-radio-group" role="radiogroup" aria-label="主题">
              {(
                [
                  ["dark", "深色"],
                  ["light", "浅色"],
                  ["system", "跟随系统"],
                ] as const
              ).map(([value, label]) => (
                <label className="ds-radio" key={value}>
                  <input
                    type="radio"
                    name="settings-theme"
                    checked={settings.theme === value}
                    onChange={() => set({ theme: value })}
                  />
                  <span className="ds-radio__dot" />
                  {label}
                </label>
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
              className="ds-select st-input"
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
              className="ds-select st-input"
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
              className="ds-select st-input"
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
                  <button className="ds-btn ds-btn--brand ds-btn--sm" type="button" title="解锁主密码，解密会话密码" onClick={() => void doUnlock()}>
                    解锁
                  </button>
                  <button className="ds-btn ds-btn--danger-subtle ds-btn--sm" type="button" title="清除主密码（需先解锁）" onClick={() => void doClear()}>
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
                  <button className="ds-btn ds-btn--brand ds-btn--sm" type="button" title="修改主密码" onClick={() => void doSet()}>
                    修改
                  </button>
                  <button className="ds-btn ds-btn--secondary ds-btn--sm" type="button" title="锁定：重新加密会话密码" onClick={() => void doLock()}>
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
                <button className="ds-btn ds-btn--brand ds-btn--sm" type="button" title="设置主密码并加密存储会话密码" onClick={() => void doSet()}>
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

        <div className="ds-card st-section">
          <div className="res-card__head">
            <span className="res-card__label">
              <Icon name="download" size={14} />软件更新
            </span>
          </div>
          <div className="st-row">
            <label>当前版本</label>
            <span className="st-kbd">v{__TERMIX_VERSION__}</span>
          </div>
          <div className="st-row st-row--col">
            <label>更新通道（默认直连）</label>
            <div className="st-seg" role="radiogroup" aria-label="更新通道">
              {(
                [
                  ["direct", "直连"],
                  ["mirror", "镜像加速"],
                  ["proxy", "代理"],
                ] as const
              ).map(([mode, text]) => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={settings.updateMode === mode}
                  className={
                    "st-seg__btn" + (settings.updateMode === mode ? " is-active" : "")
                  }
                  title={mode === "direct" ? "直连 GitHub 更新" : mode === "mirror" ? "经镜像站加速下载" : "经 HTTP 代理访问 GitHub"}
                  onClick={() => set({ updateMode: mode })}
                >
                  {text}
                </button>
              ))}
            </div>
          </div>
          {settings.updateMode === "mirror" && (
            <>
              <div className="st-row st-row--col">
                <label>镜像源（均已实测可用）</label>
                <select
                  className="ds-select"
                  value={settings.updateMirror}
                  onChange={(e) => set({ updateMirror: e.target.value })}
                >
                  {UPDATE_MIRRORS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                  <option value={CUSTOM_MIRROR_ID}>自定义…</option>
                </select>
              </div>
              {settings.updateMirror === CUSTOM_MIRROR_ID && (
                <div className="st-row st-row--col">
                  <label>自定义镜像地址</label>
                  <input
                    className="ds-input"
                    value={settings.customMirror}
                    placeholder="https://gh-proxy.com/"
                    spellCheck={false}
                    onChange={(e) => set({ customMirror: e.target.value })}
                  />
                  {"error" in normalizeMirrorBase(settings.customMirror || " ") && settings.customMirror.trim() && (
                    <div className="st-hint st-hint--error">
                      {(normalizeMirrorBase(settings.customMirror) as { error: string }).error}
                    </div>
                  )}
                </div>
              )}
              <div className="st-hint">
                {(UPDATE_MIRRORS.find((m) => m.id === settings.updateMirror)?.tested ??
                  "自定义镜像请先用下方「测试连接」验证")}
              </div>
            </>
          )}
          {settings.updateMode === "proxy" && (
            <div className="st-row st-row--col">
              <label>代理地址（HTTP/HTTPS）</label>
              <input
                className="ds-input"
                value={settings.updateProxy}
                placeholder="http://127.0.0.1:7890"
                spellCheck={false}
                onChange={(e) => set({ updateProxy: e.target.value })}
              />
              {"error" in normalizeProxyUrl(settings.updateProxy || " ") && settings.updateProxy.trim() && (
                <div className="st-hint st-hint--error">
                  {(normalizeProxyUrl(settings.updateProxy) as { error: string }).error}
                </div>
              )}
            </div>
          )}
          <div className="st-row">
            <label>当前通道</label>
            <span className="st-kbd">{describeUpdateEndpoint(settings)}</span>
          </div>
          <div className="st-row">
            <label />
            <div className="st-actions">
              <button
                className="ds-btn ds-btn--brand ds-btn--sm"
                type="button"
                disabled={checking}
                title="检查 Termix 是否有新版本"
                onClick={() => void handleCheckUpdate()}
              >
                {checking ? "检查中…" : "检查更新"}
              </button>
              <button
                className="ds-btn ds-btn--secondary ds-btn--sm"
                type="button"
                disabled={checking}
                title="用当前通道测试能否连通更新服务"
                onClick={() => void handleTestUpdateEndpoint()}
              >
                测试连接
              </button>
            </div>
          </div>
          {updateMsg && <div className="st-hint">{updateMsg}</div>}
        </div>
      </div>
    </div>
  );
}
