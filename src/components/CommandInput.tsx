import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { useT } from "../lib/i18n";
import { useApp } from "../store/app";
import { ipc, HISTORY_CHANGED_EVENT } from "../lib/ipc";
import type { CommandHistory } from "../types";

/** 历史列表最大条数（完整展示当前会话输入过的所有命令） */
const HIST_LIMIT = 200;

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return hh + ":" + mm;
}

/** 按最近时间去重：同一条命令只保留最近一次（列表已按 executedAt 降序） */
function dedupHistory(list: CommandHistory[]): CommandHistory[] {
  const seen = new Set<string>();
  const out: CommandHistory[] = [];
  for (const h of list) {
    if (seen.has(h.command)) continue;
    seen.add(h.command);
    out.push(h);
  }
  return out;
}

export function CommandInput() {
  const t = useT();
  const open = useApp((s) => s.commandInputOpen);
  const setOpen = useApp((s) => s.setCommandInputOpen);
  const activeTabId = useApp((s) => s.activeTabId);
  const tabs = useApp((s) => s.tabs);
  const [value, setValue] = useState("");
  const [history, setHistory] = useState<CommandHistory[]>([]);
  const [histOpen, setHistOpen] = useState(false);
  const [histIdx, setHistIdx] = useState(-1);
  const [histQuery, setHistQuery] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const histSearchRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
      return () => window.cancelAnimationFrame(frame);
    }
  }, [open]);

  const tab = tabs.find((t) => t.id === activeTabId);

  const execute = async (cmd: string) => {
    const command = cmd.trim();
    if (!command) return;
    if (tab?.connectionId && tab?.shellId) {
      await ipc.terminalWrite(tab.connectionId, tab.shellId, command + "\n");
      if (tab.sessionId) {
        await ipc.historyAdd(tab.sessionId, command);
        document.dispatchEvent(new CustomEvent(HISTORY_CHANGED_EVENT, { bubbles: true }));
      }
    }
    setValue("");
    setHistIdx(-1);
  };

  // 监听历史变更：终端直接输入、快捷命令等写入历史后，刷新 ↑↓ 与「历史」按钮的数据源
  useEffect(() => {
    const sessionId = tab?.sessionId;
    if (!sessionId) return;
    const reload = async () => {
      try {
        const list = await ipc.historyList(sessionId, HIST_LIMIT);
        setHistory(dedupHistory(list));
      } catch {
        /* ignore */
      }
    };
    void reload();
    document.addEventListener(HISTORY_CHANGED_EVENT, reload);
    window.addEventListener(HISTORY_CHANGED_EVENT, reload);
    return () => {
      document.removeEventListener(HISTORY_CHANGED_EVENT, reload);
      window.removeEventListener(HISTORY_CHANGED_EVENT, reload);
    };
  }, [tab?.sessionId]);

  const toggleHistory = async () => {
    const next = !histOpen;
    if (next && tab?.sessionId) {
      try {
        const list = await ipc.historyList(tab.sessionId, HIST_LIMIT);
        setHistory(dedupHistory(list));
      } catch {
        setHistory([]);
      }
      setHistQuery("");
      setTimeout(() => histSearchRef.current?.focus(), 30);
    }
    setHistOpen(next);
  };

  // 点选历史命令：填入输入框供确认/修改后复用，而非立即执行
  const reuseCommand = (cmd: string) => {
    setValue(cmd);
    setHistIdx(-1);
    setHistOpen(false);
    setHistQuery("");
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const copyCommand = async (e: React.MouseEvent, cmd: string, id: string) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(cmd);
      setCopiedId(id);
      window.setTimeout(() => setCopiedId((curr) => (curr === id ? null : curr)), 1500);
    } catch {
      /* ignore */
    }
  };

  const executeFromHistory = async (e: React.MouseEvent, cmd: string) => {
    e.stopPropagation();
    await execute(cmd);
    setHistOpen(false);
  };

  // 外部点击关闭 popover
  useEffect(() => {
    if (!histOpen) return;
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setHistOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [histOpen]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      execute(value);
    } else if (e.key === "ArrowUp") {
      if (history.length === 0) return;
      e.preventDefault();
      const next = histIdx < 0 ? history.length - 1 : Math.max(0, histIdx - 1);
      setHistIdx(next);
      setValue(history[next]?.command ?? "");
    } else if (e.key === "ArrowDown") {
      if (history.length === 0 || histIdx < 0) return;
      e.preventDefault();
      const next = histIdx + 1;
      if (next >= history.length) {
        setHistIdx(-1);
        setValue("");
      } else {
        setHistIdx(next);
        setValue(history[next]?.command ?? "");
      }
    }
  };

  const disabled = !tab?.connectionId || !tab?.shellId;

  const filtered = histQuery.trim()
    ? history.filter((h) => h.command.includes(histQuery.trim()))
    : history;

  if (!open) return null;

  return (
    <div className="command-input">
      <div className="ds-input command-input__field">
        <span className="ds-input__icon">
          <Icon name="terminal" size={14} />
        </span>
        <input
          ref={inputRef}
          type="text"
          placeholder={t("cmdinput.placeholder")}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled}
        />
      </div>
      <button
        className="ds-btn ds-btn--brand"
        type="button"
        title={t("cmdinput.execTitle")}
        onClick={() => execute(value)}
        disabled={disabled}
      >
        <Icon name="send" size={13} />
        {t("cmdinput.exec")}
      </button>
      <div className="command-input__history">
        <button
          className="ds-btn ds-btn--secondary"
          type="button"
          title={t("cmdinput.historyTitle")}
          onClick={toggleHistory}
          disabled={disabled}
        >
          <Icon name="clock" size={13} />
          {t("cmdinput.history")}
        </button>
        {histOpen && (
          <div className="command-input__popover" ref={popoverRef}>
            <div className="command-input__popover-head">
              <span className="command-input__popover-title">
                {t("cmdinput.historyTitle2", { n: history.length })}
              </span>
            </div>
            <div className="ds-input command-input__popover-search">
              <span className="ds-input__icon">
                <Icon name="search" size={12} />
              </span>
              <input
                ref={histSearchRef}
                type="text"
                placeholder={t("cmdinput.searchPlaceholder")}
                value={histQuery}
                spellCheck={false}
                onChange={(e) => setHistQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setHistOpen(false);
                }}
              />
            </div>
            {filtered.length === 0 ? (
              <div className="command-input__popover-empty">
                {histQuery.trim() ? t("cmdinput.noMatch") : t("cmdinput.noHistory")}
              </div>
            ) : (
              filtered.map((h) => (
                <div
                  key={h.id}
                  className="command-input__history-item"
                  onClick={() => reuseCommand(h.command)}
                  title={t("cmdinput.reuseTitle")}
                >
                  <div className="command-input__history-main">
                    <span className="command-input__history-cmd">{h.command}</span>
                    <span className="command-input__history-time">
                      {formatTime(h.executedAt)}
                    </span>
                  </div>
                  <div className="command-input__history-actions">
                    <button
                      type="button"
                      className="ds-btn ds-btn--xs ds-btn--secondary command-input__history-action-btn"
                      title={t("cmdinput.copyTitle")}
                      onClick={(e) => void copyCommand(e, h.command, h.id)}
                    >
                      <Icon name={copiedId === h.id ? "check-circle" : "copy"} size={11} />
                      {copiedId === h.id ? t("cmdinput.copied") : t("common.copy")}
                    </button>
                    <button
                      type="button"
                      className="ds-btn ds-btn--xs ds-btn--brand command-input__history-action-btn"
                      title={t("cmdinput.execCmdTitle")}
                      disabled={disabled}
                      onClick={(e) => void executeFromHistory(e, h.command)}
                    >
                      <Icon name="send" size={11} />
                      {t("cmdinput.exec")}
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
      <button
        className="ds-btn ds-btn--tertiary ds-btn--icon"
        type="button"
        title={t("cmdinput.closeTitle")}
        onClick={() => setOpen(false)}
      >
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}
