import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { useApp, nextTabId } from "../store/app";
import { ipc } from "../lib/ipc";
import { useClampedMenuPosition } from "../lib/contextMenu";
import { promptDialog } from "../store/feedback";

interface CtxMenu {
  x: number;
  y: number;
  tabId: string;
}

export function EditorTabs() {
  const tabs = useApp((s) => s.tabs);
  const activeTabId = useApp((s) => s.activeTabId);
  const setActiveTab = useApp((s) => s.setActiveTab);
  const closeTab = useApp((s) => s.closeTab);
  const addTab = useApp((s) => s.addTab);
  const updateTab = useApp((s) => s.updateTab);
  const requestReconnect = useApp((s) => s.requestReconnect);
  const [ctx, setCtx] = useState<CtxMenu | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuReturnRef = useRef<HTMLElement | null>(null);
  const menuPosition = useClampedMenuPosition(ctx, menuRef);

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

  // 分屏 pane 由历史数据兼容渲染（新标签不再提供分屏入口）

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
      title: t.title + "（副本）",
      status: "connecting",
    });
  };

  // 重命名标签：仅修改标题
  const renameTab = async () => {
    if (!ctx) return;
    const t = tabs.find((x) => x.id === ctx.tabId);
    if (!t) return;
    const name = await promptDialog({
      title: "重命名标签",
      defaultValue: t.title,
      confirmText: "重命名",
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
    if (activeTab.connectionId) {
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
        manualClosed: true,
        connectionId: undefined,
        shellId: undefined,
        error: undefined,
      });
      return;
    }
    updateTab(activeTab.id, {
      status: "connecting",
      manualClosed: false,
      error: undefined,
    });
    requestReconnect(activeTab.id);
  };

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
      <div className="editor-tabs__spacer" />
      {activeTab && (
        <div className="editor-tabs__actions">
          <button
            className="ds-btn ds-btn--tertiary ds-btn--icon"
            type="button"
            title={
              activeTab.status === "connected"
                ? "断开当前连接"
                : activeTab.status === "connecting"
                  ? "正在连接…"
                  : "重新连接"
            }
            disabled={activeTab.status === "connecting"}
            onClick={() => void toggleConnection()}
          >
            <Icon
              name={activeTab.status === "connected" ? "zap" : "plug"}
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
            title="关闭当前标签并断开连接"
            onClick={() => {
              void destroyAndClose(ctx.tabId);
              setCtx(null);
            }}
          >
            <Icon name="x" size={12} />
            关闭标签
          </button>
          <button
            type="button"
            className="ctx-menu__item"
            title="关闭当前标签以外的所有标签"
            onClick={() => {
              closeOthers();
              setCtx(null);
            }}
          >
            <Icon name="more-h" size={12} />
            关闭其他
          </button>
          <button
            type="button"
            className="ctx-menu__item"
            title="关闭当前标签右侧的所有标签"
            onClick={() => {
              closeRight();
              setCtx(null);
            }}
          >
            <Icon name="chevron-right" size={12} />
            关闭右侧
          </button>
          <div className="ctx-menu__sep" />
          <button
            type="button"
            className="ctx-menu__item"
            title="复制当前标签（同一连接新开一个终端）"
            onClick={() => {
              duplicateTab();
              setCtx(null);
            }}
          >
            <Icon name="copy" size={12} />
            复制标签
          </button>
          <button
            type="button"
            className="ctx-menu__item"
            title="重命名当前标签"
            onClick={() => {
              void renameTab();
              setCtx(null);
            }}
          >
            <Icon name="edit" size={12} />
            重命名标签
          </button>
        </div>
      )}
    </div>
  );
}
