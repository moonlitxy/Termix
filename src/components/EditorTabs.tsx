import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { useApp, nextTabId } from "../store/app";
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
  const addTab = useApp((s) => s.addTab);
  const updateTab = useApp((s) => s.updateTab);
  const [ctx, setCtx] = useState<CtxMenu | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

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
  const renameTab = () => {
    if (!ctx) return;
    const t = tabs.find((x) => x.id === ctx.tabId);
    if (!t) return;
    const name = window.prompt("重命名标签", t.title);
    if (name && name.trim()) {
      updateTab(ctx.tabId, { title: name.trim() });
    }
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
      {tabs.filter((t) => !t.hidden).map((tab) => (
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
              renameTab();
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
