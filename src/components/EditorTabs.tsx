import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { useApp } from "../store/app";
import { ipc } from "../lib/ipc";

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
  const [ctx, setCtx] = useState<CtxMenu | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const destroyAndClose = async (tabId: string) => {
    const t = tabs.find((x) => x.id === tabId);
    try {
      if (t?.connectionId && t.shellId) {
        await ipc.terminalDestroy(t.connectionId, t.shellId);
      }
      if (t?.connectionId) {
        await ipc.sessionDisconnect(t.connectionId);
      }
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

  useEffect(() => {
    if (!ctx) return;
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
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [ctx]);

  const handleClose = async (e: React.MouseEvent, tabId: string) => {
    e.stopPropagation();
    await destroyAndClose(tabId);
  };

  return (
    <div className="editor-tabs">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={"ds-editortab" + (tab.id === activeTabId ? " is-active" : "")}
          onClick={() => setActiveTab(tab.id)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setActiveTab(tab.id);
            setCtx({ x: e.clientX, y: e.clientY, tabId: tab.id });
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
      <div className="editor-tabs__actions">
        <button className="ds-btn ds-btn--tertiary ds-btn--icon" type="button" title="分屏">
          <Icon name="columns" size={15} />
        </button>
        <button
          className="ds-btn ds-btn--tertiary ds-btn--icon"
          type="button"
          title="最大化"
        >
          <Icon name="arrow-expand" size={15} />
        </button>
        <button className="ds-btn ds-btn--tertiary ds-btn--icon" type="button" title="更多">
          <Icon name="more-h" size={15} />
        </button>
      </div>

      {ctx && (
        <div
          className="ctx-menu"
          ref={menuRef}
          style={{ left: ctx.x, top: ctx.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="ctx-menu__item"
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
            onClick={() => {
              closeRight();
              setCtx(null);
            }}
          >
            <Icon name="chevron-right" size={12} />
            关闭右侧
          </button>
        </div>
      )}
    </div>
  );
}
