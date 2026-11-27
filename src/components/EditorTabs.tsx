import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";
import { useApp, nextTabId } from "../store/app";
import { ipc } from "../lib/ipc";
import { useClampedMenuPosition } from "../lib/contextMenu";
import { promptDialog } from "../store/feedback";
import { createSplitTab } from "../lib/tabs";
import { useT } from "../lib/i18n";
import { connButtonClass, toConnVisual } from "../lib/connectionStatus";
import type { Session } from "../types";

interface CtxMenu {
  x: number;
  y: number;
  tabId: string;
}

export function EditorTabs() {
  const tr = useT();
  const tabs = useApp((s) => s.tabs);
  const activeTabId = useApp((s) => s.activeTabId);
  const setActiveTab = useApp((s) => s.setActiveTab);
  const closeTab = useApp((s) => s.closeTab);
  const addTab = useApp((s) => s.addTab);
  const updateTab = useApp((s) => s.updateTab);
  const requestReconnect = useApp((s) => s.requestReconnect);
  const sessions = useApp((s) => s.sessions);
  const groups = useApp((s) => s.groups);
  const [ctx, setCtx] = useState<CtxMenu | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [addMenuPos, setAddMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [addMenuQuery, setAddMenuQuery] = useState("");
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const addMenuInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuReturnRef = useRef<HTMLElement | null>(null);
  const menuPosition = useClampedMenuPosition(ctx, menuRef);

  const groupNameById = useMemo(
    () => new Map(groups.map((group) => [group.id, group.name])),
    [groups]
  );

  const allSessions = useMemo(() => {
    return sessions
      .slice()
      .sort((a, b) => {
        const byRecent = (b.lastConnectedAt ?? 0) - (a.lastConnectedAt ?? 0);
        return byRecent || a.name.localeCompare(b.name, "zh-CN");
      });
  }, [sessions]);

  const recentSessions = useMemo(() => {
    return allSessions
      .filter((session) => session.lastConnectedAt)
      .slice(0, 5);
  }, [allSessions]);

  const normalizedAddQuery = addMenuQuery.trim().toLowerCase();

  const filteredSessions = useMemo(() => {
    if (!normalizedAddQuery) return allSessions;
    return allSessions.filter((session) => {
      const groupName = session.groupId
        ? groupNameById.get(session.groupId) ?? ""
        : "";
      return [
        session.name,
        session.username,
        session.host,
        String(session.port),
        groupName,
      ].some((value) => value.toLowerCase().includes(normalizedAddQuery));
    });
  }, [allSessions, groupNameById, normalizedAddQuery]);

  const otherSessions = useMemo(() => {
    if (normalizedAddQuery) return [];
    const recentIds = new Set(recentSessions.map((session) => session.id));
    return allSessions.filter((session) => !recentIds.has(session.id));
  }, [allSessions, normalizedAddQuery, recentSessions]);

  const openSessionTab = (s: Session) => {
    useApp.setState({ activity: "terminal" });
    addTab({
      id: nextTabId(),
      kind: "terminal",
      sessionId: s.id,
      title: s.name,
      status: "connecting",
    });
  };

  const closeAddMenu = () => {
    setAddMenuOpen(false);
    setAddMenuQuery("");
  };

  const toggleAddMenu = () => {
    if (addMenuOpen) {
      closeAddMenu();
      return;
    }
    setAddMenuQuery("");
    const rect = addBtnRef.current?.getBoundingClientRect();
    if (rect) {
      setAddMenuPos({
        x: Math.max(8, Math.min(rect.left, window.innerWidth - 356)),
        y: rect.bottom + 4,
      });
    }
    setAddMenuOpen(true);
  };

  useEffect(() => {
    if (!addMenuOpen) return;
    const timer = window.setTimeout(() => addMenuInputRef.current?.focus(), 0);
    const onEsc = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAddMenuOpen(false);
    };
    document.addEventListener("keydown", onEsc);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("keydown", onEsc);
    };
  }, [addMenuOpen]);

  const openTabMenu = (tabId: string, position: { x: number; y: number }) => {
    menuReturnRef.current = document.activeElement as HTMLElement | null;
    setActiveTab(tabId);
    setCtx({ ...position, tabId });
  };

  const destroyAndClose = async (tabId: string) => {
    // 分屏 pane 标签随主标签一起销毁
    const related = tabs.filter((x) => x.id === tabId || x.splitOf === tabId);
    try {
      await Promise.all(
        related.map(async (x) => {
          if (x.connectionId && x.shellId) {
            await ipc.terminalDestroy(x.connectionId, x.shellId);
          }
          if (x.connectionId) {
            await ipc.sessionDisconnect(x.connectionId);
          }
        })
      );
    } catch {
      // 忽略关闭时的错误
    }
    closeTab(tabId);
  };

  const closeOthers = () => {
    if (!ctx) return;
    void Promise.all(
      tabs.filter((t) => t.id !== ctx.tabId).map((t) => destroyAndClose(t.id))
    );
  };

  const closeRight = () => {
    if (!ctx) return;
    const idx = tabs.findIndex((t) => t.id === ctx.tabId);
    void Promise.all(
      tabs.filter((_, i) => i > idx).map((t) => destroyAndClose(t.id))
    );
  };

  // 分屏 pane 作为隐藏标签渲染在所属主标签右侧

  // 复制标签：基于同一会话新建一个独立连接的新标签
  const duplicateTab = () => {
    if (!ctx) return;
    const t = tabs.find((x) => x.id === ctx.tabId);
    if (!t) return;
    console.log("[tab] duplicate", t.id, "session", t.sessionId);
    addTab({
      id: nextTabId(),
      kind: t.kind,
      sessionId: t.sessionId,
      title: t.title + tr("tab.copySuffix"),
      status: "connecting",
    });
  };

  const splitTab = () => {
    if (!ctx) return;
    const t = tabs.find((x) => x.id === ctx.tabId);
    if (!t || t.hidden) return;
    addTab(createSplitTab(t, nextTabId()));
    setCtx(null);
  };

  // 重命名标签：仅修改标题
  const renameTab = async () => {
    if (!ctx) return;
    const t = tabs.find((x) => x.id === ctx.tabId);
    if (!t) return;
    const name = await promptDialog({
      title: tr("tab.renameTitle"),
      defaultValue: t.title,
      confirmText: tr("tab.renameConfirm"),
    });
    if (name && name.trim()) {
      updateTab(ctx.tabId, { title: name.trim() });
    }
  };

  useEffect(() => {
    if (!ctx) return;
    const frame = window.requestAnimationFrame(() => {
      menuRef.current
        ?.querySelector<HTMLElement>("button:not([disabled])")
        ?.focus();
    });
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setCtx(null);
      }
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCtx(null);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
      menuReturnRef.current?.focus();
      menuReturnRef.current = null;
    };
  }, [ctx]);

  const handleClose = async (e: React.MouseEvent, tabId: string) => {
    e.stopPropagation();
    await destroyAndClose(tabId);
  };

  const activeTab = tabs.find((t) => t.id === activeTabId && !t.hidden);

  const toggleConnection = async () => {
    if (!activeTab) return;
    if (activeTab.connectionId && activeTab.status !== "disconnected") {
      try {
        if (activeTab.shellId) {
          await ipc.terminalDestroy(activeTab.connectionId, activeTab.shellId);
        }
        await ipc.sessionDisconnect(activeTab.connectionId);
      } catch {
        // 连接可能已失效，忽略
      }
      updateTab(activeTab.id, {
        status: "disconnected",
        connectionId: undefined,
        shellId: undefined,
        error: undefined,
      });
      return;
    }
    updateTab(activeTab.id, {
      status: "connecting",
      connectionId: undefined,
      shellId: undefined,
      error: undefined,
    });
    requestReconnect(activeTab.id);
  };

  const renderAddMenuSession = (session: Session) => (
    <button
      key={session.id}
      type="button"
      className="ctx-menu__item editor-tabs__menu-session"
      title={`${session.name} (${session.username}@${session.host}:${session.port})`}
      onClick={() => {
        closeAddMenu();
        openSessionTab(session);
      }}
    >
      <Icon name="terminal" size={13} />
      <div className="editor-tabs__session-text">
        <span className="editor-tabs__session-name">{session.name}</span>
        <span className="editor-tabs__session-host">
          {session.username}@{session.host}:{session.port}
        </span>
      </div>
    </button>
  );

  return (
    <div className="editor-tabs">
      {tabs.filter((t) => !t.hidden).map((tab) => (
        <div
          key={tab.id}
          className={"ds-editortab" + (tab.id === activeTabId ? " is-active" : "")}
          onClick={() => setActiveTab(tab.id)}
          role="button"
          tabIndex={0}
          aria-current={tab.id === activeTabId ? "true" : undefined}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setActiveTab(tab.id);
            } else if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") {
              e.preventDefault();
              const rect = e.currentTarget.getBoundingClientRect();
              openTabMenu(tab.id, { x: rect.right, y: rect.bottom });
            } else if (e.key === "Delete") {
              e.preventDefault();
              void destroyAndClose(tab.id);
            }
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            openTabMenu(tab.id, { x: e.clientX, y: e.clientY });
          }}
          title={tab.title}
        >
          <Icon name="terminal" size={13} />
          <span className="ds-editortab__title">{tab.title}</span>
          <span
            className="ds-editortab__close"
            onClick={(e) => handleClose(e, tab.id)}
          >
            <Icon name="x" size={12} />
          </span>
        </div>
      ))}
      <div className="editor-tabs__add-wrap">
        <button
          ref={addBtnRef}
          className={
            "editor-tabs__add-btn" + (addMenuOpen ? " is-active" : "")
          }
          type="button"
          title={tr("tab.newTab")}
          onClick={toggleAddMenu}
        >
          <Icon name="plus" size={13} />
        </button>
        {addMenuOpen && addMenuPos &&
          createPortal(
            <>
              <div
                className="editor-tabs__add-backdrop"
                onClick={closeAddMenu}
              />
              <div
                className="ctx-menu editor-tabs__add-menu is-portal"
                style={{ left: addMenuPos.x, top: addMenuPos.y }}
              >
              <div className="editor-tabs__menu-search">
                <Icon name="search" size={12} />
                <input
                  ref={addMenuInputRef}
                  value={addMenuQuery}
                  placeholder={tr("tab.searchConnections")}
                  aria-label={tr("tab.searchConnections")}
                  spellCheck={false}
                  onChange={(event) => setAddMenuQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    const first = filteredSessions[0];
                    if (!first) return;
                    event.preventDefault();
                    closeAddMenu();
                    openSessionTab(first);
                  }}
                />
              </div>
              <div className="editor-tabs__menu-list">
                {allSessions.length === 0 ? (
                  <div className="editor-tabs__menu-empty">
                    {tr("tab.noConnections")}
                  </div>
                ) : normalizedAddQuery ? (
                  <>
                    <div className="editor-tabs__menu-head">
                      <Icon name="search" size={12} />
                      <span>{tr("tab.searchResults")}</span>
                    </div>
                    {filteredSessions.length === 0 ? (
                      <div className="editor-tabs__menu-empty">
                        {tr("tab.noSearchResults")}
                      </div>
                    ) : (
                      filteredSessions.map(renderAddMenuSession)
                    )}
                  </>
                ) : (
                  <>
                    {recentSessions.length > 0 && (
                      <>
                        <div className="editor-tabs__menu-head">
                          <Icon name="clock" size={12} />
                          <span>{tr("tab.recentConnections")}</span>
                        </div>
                        {recentSessions.map(renderAddMenuSession)}
                      </>
                    )}
                    {otherSessions.length > 0 && (
                      <>
                        <div className="editor-tabs__menu-head">
                          <Icon name="terminal" size={12} />
                          <span>{tr("tab.allConnections")}</span>
                        </div>
                        {otherSessions.map(renderAddMenuSession)}
                      </>
                    )}
                  </>
                )}
              </div>
              <div className="ctx-menu__sep" />
              <button
                type="button"
                className="ctx-menu__item"
                title={tr("session.newConnTitle")}
                onClick={() => {
                  closeAddMenu();
                  useApp.getState().openNewConnection();
                }}
              >
                <Icon name="plus" size={12} />
                {tr("session.newConnTitle")}
              </button>
              </div>
            </>,
            document.body
          )}
      </div>
      <div className="editor-tabs__spacer" />
      {activeTab && (
        <div className="editor-tabs__actions">
          <button
            className={
              "ds-btn ds-btn--tertiary ds-btn--icon " +
              connButtonClass(toConnVisual(activeTab.status))
            }
            type="button"
            title={
              activeTab.status === "connected"
                ? tr("tab.disconnect")
                : activeTab.status === "connecting"
                  ? tr("tab.connecting")
                  : tr("tab.reconnect")
            }
            disabled={activeTab.status === "connecting"}
            onClick={() => void toggleConnection()}
          >
            <Icon
              name={activeTab.status === "connected" ? "plug" : "zap"}
              size={15}
            />
          </button>
        </div>
      )}

      {ctx && (
        <div
          className="ctx-menu"
          ref={menuRef}
          style={{ left: menuPosition?.x ?? ctx.x, top: menuPosition?.y ?? ctx.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="ctx-menu__item"
            title={tr("tab.closeTabTitle")}
            onClick={() => {
              void destroyAndClose(ctx.tabId);
              setCtx(null);
            }}
          >
            <Icon name="x" size={12} />{tr("tab.closeTab")}</button>
          <button
            type="button"
            className="ctx-menu__item"
            title={tr("tab.closeOthersTitle")}
            onClick={() => {
              closeOthers();
              setCtx(null);
            }}
          >
            <Icon name="more-h" size={12} />{tr("tab.closeOthers")}</button>
          <button
            type="button"
            className="ctx-menu__item"
            title={tr("tab.closeRightTitle")}
            onClick={() => {
              closeRight();
              setCtx(null);
            }}
          >
            <Icon name="chevron-right" size={12} />{tr("tab.closeRight")}</button>
          <div className="ctx-menu__sep" />
          <button
            type="button"
            className="ctx-menu__item"
            title={tr("tab.duplicateTitle")}
            onClick={() => {
              duplicateTab();
              setCtx(null);
            }}
          >
            <Icon name="copy" size={12} />{tr("tab.duplicate")}</button>
          <button
            type="button"
            className="ctx-menu__item"
            title={tr("tab.splitTitle")}
            onClick={splitTab}
          >
            <Icon name="columns" size={12} />{tr("tab.split")}</button>
          <button
            type="button"
            className="ctx-menu__item"
            title={tr("tab.renameTabTitle")}
            onClick={() => {
              void renameTab();
              setCtx(null);
            }}
          >
            <Icon name="edit" size={12} />{tr("tab.renameTab")}</button>
        </div>
      )}
    </div>
  );
}
