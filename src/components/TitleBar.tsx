import { useState } from "react";
import { Icon } from "./Icon";
import { useApp } from "../store/app";
import { ipc } from "../lib/ipc";
import { terminalRegistry } from "../lib/terminalRegistry";
import type { Tab } from "../types";

/** 标签状态 → 状态点样式（复用 ds-dot，保证视觉统一） */
const STATUS_DOT: Record<Tab["status"], string> = {
  connecting: "ds-dot--warning",
  connected: "ds-dot--success",
  disconnected: "ds-dot--muted",
  error: "ds-dot--error",
};

export function TitleBar() {
  const searchKeyword = useApp((s) => s.searchKeyword);
  const setSearch = useApp((s) => s.setSearch);
  const activity = useApp((s) => s.activity);
  const setActivity = useApp((s) => s.setActivity);
  const tabs = useApp((s) => s.tabs);
  const activeTabId = useApp((s) => s.activeTabId);
  const sessions = useApp((s) => s.sessions);
  const setActiveTab = useApp((s) => s.setActiveTab);
  const openNewConnection = useApp((s) => s.openNewConnection);
  const [menuOpen, setMenuOpen] = useState(false);
  const [avatarOpen, setAvatarOpen] = useState(false);

  // 连接/断开切换：已连接时断开并清空连接引用；断开时触发重新连接
  const toggleConnection = async () => {
    const st = useApp.getState();
    const tab = st.tabs.find((t) => t.id === st.activeTabId);
    if (!tab) return;
    if (tab.connectionId) {
      // 断开：销毁 shell、断开连接、清空连接引用并标记手动断开（不自动重连）
      try {
        if (tab.shellId) {
          await ipc.terminalDestroy(tab.connectionId, tab.shellId);
        }
        await ipc.sessionDisconnect(tab.connectionId);
      } catch {
        // 连接可能已失效，忽略
      }
      st.updateTab(tab.id, {
        status: "disconnected",
        manualClosed: true,
        connectionId: undefined,
        shellId: undefined,
        error: undefined,
      });
      terminalRegistry
        .get(tab.id)
        ?.write("\r\n\x1b[33m连接已断开（手动断开）\x1b[0m\r\n");
    } else {
      // 重新连接：复位连接状态并通知终端视图重建连接
      st.updateTab(tab.id, {
        status: "connecting",
        manualClosed: false,
        error: undefined,
      });
      st.requestReconnect(tab.id);
    }
  };

  // 当前激活连接（分屏 pane 不单独占用标题栏）
  const activeTab = tabs.find((t) => t.id === activeTabId && !t.hidden);
  const activeSession = activeTab
    ? sessions.find((s) => s.id === activeTab.sessionId)
    : undefined;

  // 已打开的连接标签（供下拉切换）
  const openTabs = tabs.filter((t) => !t.hidden);

  // 动态展示真实服务器信息：会话名 · user@host；无连接时给出明确占位
  const label = activeSession
    ? `${activeSession.name} · ${activeSession.username}@${activeSession.host}`
    : activeTab
      ? activeTab.title
      : "未连接";

  return (
    <div className="titlebar">
      <div className="titlebar__left">
        <span className="titlebar__brand">
          <Icon name="terminal" size={14} />
          Termix
        </span>
        <div className="titlebar__conn-select-wrap">
          <button
            className={"titlebar__conn-select" + (menuOpen ? " is-active" : "")}
            type="button"
            title={activeTab ? `当前连接：${label}` : "当前无连接，点击新建连接"}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <span
              className={
                "ds-dot " + (activeTab ? STATUS_DOT[activeTab.status] : "ds-dot--muted")
              }
            />
            <span className="titlebar__conn-label">{label}</span>
            <Icon name="chevron-down" size={12} />
          </button>
          {menuOpen && (
            <>
              <div
                className="titlebar__conn-backdrop"
                onClick={() => setMenuOpen(false)}
              />
              <div className="ctx-menu titlebar__conn-menu">
                {openTabs.length === 0 && (
                  <div className="titlebar__conn-empty">暂无已打开的连接</div>
                )}
                {openTabs.map((t) => {
                  const s = sessions.find((x) => x.id === t.sessionId);
                  const isActive = t.id === activeTabId;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      className={"ctx-menu__item" + (isActive ? " is-active" : "")}
                      title={
                        s ? `切换到 ${s.name}（${s.username}@${s.host}）` : t.title
                      }
                      onClick={() => {
                        setActiveTab(t.id);
                        setMenuOpen(false);
                      }}
                    >
                      <span
                        className={"ds-dot " + (STATUS_DOT[t.status] ?? "ds-dot--muted")}
                      />
                      <span className="titlebar__conn-item-name">
                        {s?.name ?? t.title}
                      </span>
                      {s && <span className="titlebar__conn-item-host">{s.host}</span>}
                    </button>
                  );
                })}
                <div className="ctx-menu__sep" />
                <button
                  type="button"
                  className="ctx-menu__item"
                  title="新建连接：打开新建会话窗口"
                  onClick={() => {
                    setMenuOpen(false);
                    openNewConnection();
                  }}
                >
                  <Icon name="plus" size={14} />
                  新建连接
                </button>
              </div>
            </>
          )}
        </div>
        <div className="ds-input titlebar__search">
          <span className="ds-input__icon">
            <Icon name="search" size={14} />
          </span>
          <input
            type="text"
            placeholder="搜索会话 / 命令 / 文件"
            value={searchKeyword}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>
      <div className="titlebar__right">
        <button
          className={
            "ds-btn ds-btn--tertiary ds-btn--icon titlebar__conn-btn" +
            (activeTab?.status === "connected" ? " is-connected" : "")
          }
          type="button"
          title={
            activeTab?.status === "connected"
              ? "断开当前连接"
              : activeTab?.status === "connecting"
                ? "正在连接…"
                : "重新连接"
          }
          disabled={!activeTab || activeTab.status === "connecting"}
          onClick={() => void toggleConnection()}
        >
          <Icon name={activeTab?.status === "connected" ? "zap" : "plug"} size={16} />
        </button>
        <button
          className={
            "ds-btn ds-btn--tertiary ds-btn--icon" +
            (activity === "settings" ? " is-active" : "")
          }
          type="button"
          title="设置"
          onClick={() => setActivity("settings")}
        >
          <Icon name="settings" size={16} />
        </button>
        <button className="ds-btn ds-btn--tertiary ds-btn--icon" type="button" title="通知">
          <Icon name="bell" size={16} />
        </button>
        <div className="titlebar__avatar-wrap">
          <button
            className={
              "titlebar__avatar" + (avatarOpen ? " is-active" : "")
            }
            type="button"
            title="用户菜单"
            aria-label="用户菜单"
            onClick={() => setAvatarOpen((v) => !v)}
          >
            <Icon name="user" size={14} />
          </button>
          {avatarOpen && (
            <>
              <div
                className="titlebar__conn-backdrop"
                onClick={() => setAvatarOpen(false)}
              />
              <div className="ctx-menu titlebar__avatar-menu">
                <div className="titlebar__avatar-info">
                  <div className="titlebar__avatar-name">Termix 本地用户</div>
                  <div className="titlebar__avatar-meta">
                    连接配置与偏好保存在本机
                  </div>
                </div>
                <div className="ctx-menu__sep" />
                <button
                  type="button"
                  className="ctx-menu__item"
                  title="打开系统偏好设置"
                  onClick={() => {
                    setAvatarOpen(false);
                    setActivity("settings");
                  }}
                >
                  <Icon name="settings" size={12} />
                  系统偏好设置
                </button>
                <button
                  type="button"
                  className="ctx-menu__item"
                  title="查看帮助与文档"
                  onClick={() => {
                    setAvatarOpen(false);
                    setActivity("help");
                  }}
                >
                  <Icon name="help" size={12} />
                  帮助与文档
                </button>
                <button
                  type="button"
                  className="ctx-menu__item"
                  title="查看 Termix 版本信息"
                  onClick={() => {
                    setAvatarOpen(false);
                    // 进入帮助页并定位到「关于 Termix」区块（版本号由构建配置注入，避免硬编码）
                    useApp.getState().setHelpAnchor("about");
                    setActivity("help");
                  }}
                >
                  <Icon name="info-circle" size={12} />
                  关于 Termix
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
