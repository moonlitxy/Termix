import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon";
import { useApp, nextTabId } from "../store/app";
import { ipc } from "../lib/ipc";
import {
  PALETTE_ACTIVITIES,
  searchPalette,
  type PaletteItem,
} from "../lib/commandPalette";
import { useFocusTrap } from "../lib/focusTrap";
import type { Snippet } from "../types";

const KIND_LABEL = {
  session: "会话",
  snippet: "片段",
  history: "历史",
  activity: "入口",
} as const;

export function CommandPalette() {
  const open = useApp((s) => s.paletteOpen);
  const closePalette = useApp((s) => s.closePalette);
  const setActivity = useApp((s) => s.setActivity);
  const addTab = useApp((s) => s.addTab);
  const tabs = useApp((s) => s.tabs);
  const activeTabId = useApp((s) => s.activeTabId);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [histories, setHistories] = useState<Record<string, string[]>>({});
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useFocusTrap(dialogRef, open);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(0);
    ipc.snippetList().then(setSnippets).catch(() => setSnippets([]));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const active = tabs.find((t) => t.id === activeTabId);
    if (!active?.sessionId || histories[active.sessionId]) return;
    ipc.historyList(active.sessionId, 30)
      .then((list) => {
        setHistories((current) => ({
          ...current,
          [active.sessionId]: list.map((x) => x.command),
        }));
      })
      .catch(() => {
        setHistories((current) => ({ ...current, [active.sessionId]: [] }));
      });
  }, [open, tabs, activeTabId, histories]);

  const items = useMemo<PaletteItem[]>(() => {
    const sessions = useApp.getState().sessions;
    const active = tabs.find((t) => t.id === activeTabId);
    const historyCommands = active?.sessionId
      ? [...new Set(histories[active.sessionId] ?? [])].map((command, i) => ({
          id: `history-${i}-${command}`,
          title: command,
        }))
      : [];
    return [
      ...searchPalette(query, "session", sessions.map((s) => ({
        id: s.id,
        title: s.name,
        subtitle: `${s.username}@${s.host}`,
      }))),
      ...searchPalette(query, "snippet", snippets.map((s) => ({
        id: s.id,
        title: s.title,
        subtitle: s.command,
      }))),
      ...searchPalette(query, "history", historyCommands),
      ...searchPalette(query, "activity", PALETTE_ACTIVITIES),
    ].sort((a, b) => a.score - b.score || a.title.localeCompare(b.title));
  }, [query, snippets, histories, tabs, activeTabId]);

  useEffect(() => {
    setSelected((current) => Math.min(current, Math.max(0, items.length - 1)));
  }, [items.length]);

  const runItem = async (item: PaletteItem) => {
    closePalette();
    if (item.kind === "activity") {
      setActivity(item.id as never);
      return;
    }
    if (item.kind === "session") {
      const session = useApp.getState().sessions.find((s) => s.id === item.id);
      if (!session) return;
      addTab({
        id: nextTabId(),
        kind: "terminal",
        sessionId: session.id,
        title: session.name,
        status: "connecting",
      });
      setActivity("terminal");
      return;
    }
    if (item.kind === "snippet") {
      setActivity("snippets");
      return;
    }
    // 历史命令：切回终端并写入当前 shell，由用户确认后执行
    setActivity("terminal");
  };

  if (!open) return null;

  return (
    <div className="palette-overlay" onMouseDown={closePalette}>
      <div
        className="palette"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="全局搜索"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="palette__search">
          <Icon name="search" size={15} />
          <input
            ref={inputRef}
            value={query}
            placeholder="搜索会话、片段、历史命令或功能入口"
            autoFocus
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                closePalette();
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                setSelected((v) => Math.min(v + 1, items.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelected((v) => Math.max(v - 1, 0));
              } else if (e.key === "Enter" && items[selected]) {
                e.preventDefault();
                void runItem(items[selected]);
              }
            }}
          />
        </div>
        <div className="palette__list" role="listbox">
          {items.length === 0 && (
            <div className="palette__empty">没有匹配结果</div>
          )}
          {items.map((item, index) => (
            <button
              key={item.kind + item.id}
              type="button"
              className={"palette__item" + (index === selected ? " is-active" : "")}
              role="option"
              aria-selected={index === selected}
              onMouseEnter={() => setSelected(index)}
              onClick={() => void runItem(item)}
            >
              <span className="palette__kind">{KIND_LABEL[item.kind]}</span>
              <span className="palette__title">{item.title}</span>
              {item.subtitle && (
                <span className="palette__subtitle">{item.subtitle}</span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
