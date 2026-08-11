import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { useApp } from "../store/app";
import { ipc } from "../lib/ipc";
import { terminalRegistry } from "../lib/terminalRegistry";
import { parseVariables } from "./SnippetsView";
import type { Snippet } from "../types";

interface QuickCmdEditing {
  title: string;
  command: string;
  vars: { name: string; defaultValue: string }[];
  values: Record<string, string>;
}

export function Toolbar() {
  const activeTabId = useApp((s) => s.activeTabId);
  const tabs = useApp((s) => s.tabs);
  const sessions = useApp((s) => s.sessions);
  const updateTab = useApp((s) => s.updateTab);

  const tab = tabs.find((t) => t.id === activeTabId);
  const session = tab ? sessions.find((s) => s.id === tab.sessionId) : undefined;

  // 终端内搜索（Ctrl+F 打开）
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  // 快捷命令面板（复用命令片段数据）
  const [cmdOpen, setCmdOpen] = useState(false);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [cmdQuery, setCmdQuery] = useState("");
  const [cmdEditing, setCmdEditing] = useState<QuickCmdEditing | null>(null);
  const cmdSearchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onSearch = () => {
      setSearchOpen(true);
      setTimeout(() => searchRef.current?.focus(), 30);
    };
    document.addEventListener("termix:search", onSearch);
    return () => document.removeEventListener("termix:search", onSearch);
  }, []);

  const doFind = (dir: "next" | "prev") => {
    if (!tab) return;
    const s = terminalRegistry.getSearch(tab.id);
    if (!s || !query) return;
    if (dir === "next") s.findNext(query, { caseSensitive: false });
    else s.findPrevious(query, { caseSensitive: false });
  };

  const dotClass =
    tab?.status === "connected"
      ? "ds-dot--success"
      : tab?.status === "connecting"
      ? "ds-dot--warning"
      : "ds-dot--error";

  const handleDisconnect = async () => {
    if (!tab || !tab.connectionId) return;
    try {
      if (tab.shellId) {
        await ipc.terminalDestroy(tab.connectionId, tab.shellId);
      }
      await ipc.sessionDisconnect(tab.connectionId);
      updateTab(tab.id, { status: "disconnected" });
    } catch {
      // 忽略
    }
  };

  const handleCopy = async () => {
    if (!tab) return;
    const term = terminalRegistry.get(tab.id);
    const sel = term?.getSelection()?.trim();
    if (!sel) {
      window.alert("请先在终端中选中文本");
      return;
    }
    try {
      await navigator.clipboard.writeText(sel);
    } catch (e) {
      console.error("[terminal] copy failed:", e);
    }
  };

  const handleSaveLog = () => {
    if (!tab) return;
    const buf = terminalRegistry.getBuffer(tab.id);
    if (!buf.trim()) {
      window.alert("当前终端暂无输出日志");
      return;
    }
    const name = `termix-${tab.title || "session"}-${Date.now()}.log`;
    const blob = new Blob([buf], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleClear = () => {
    if (!tab) return;
    const term = terminalRegistry.get(tab.id);
    term?.clear();
    terminalRegistry.clearBuffer(tab.id);
  };

  // ---- 快捷命令 ----
  const sendCommand = async (command: string) => {
    if (!tab?.connectionId || !tab.shellId) {
      window.alert("请先打开一个已连接的终端标签页");
      return;
    }
    try {
      await ipc.terminalWrite(tab.connectionId, tab.shellId, command + "\n");
    } catch (e) {
      console.error("[quick-cmd] send failed:", e);
    }
  };

  const toggleQuickCmd = async () => {
    const next = !cmdOpen;
    setCmdOpen(next);
    setCmdEditing(null);
    setCmdQuery("");
    if (next) {
      try {
        setSnippets(await ipc.snippetList());
      } catch {
        setSnippets([]);
      }
      setTimeout(() => cmdSearchRef.current?.focus(), 30);
    }
  };

  const runSnippet = async (s: Snippet) => {
    // 含 {{var}} 占位符时先让用户填写变量
    const placeholders = [...s.command.matchAll(/\{\{\s*([\w-]+)\s*\}\}/g)].map((m) => m[1]);
    if (placeholders.length > 0) {
      const declared = parseVariables(s.variables);
      const vars = placeholders.map((name) => ({
        name,
        defaultValue: declared.find((d) => d.name === name)?.defaultValue ?? "",
      }));
      setCmdEditing({
        title: s.title,
        command: s.command,
        vars,
        values: Object.fromEntries(vars.map((v) => [v.name, v.defaultValue])),
      });
      return;
    }
    setCmdOpen(false);
    await sendCommand(s.command);
  };

  const confirmQuickCmd = async () => {
    if (!cmdEditing) return;
    let cmd = cmdEditing.command;
    for (const v of cmdEditing.vars) {
      cmd = cmd.replaceAll(`{{${v.name}}}`, cmdEditing.values[v.name] ?? "");
    }
    setCmdEditing(null);
    setCmdOpen(false);
    await sendCommand(cmd);
  };

  const filteredSnippets = cmdQuery.trim()
    ? snippets.filter(
        (s) => s.title.includes(cmdQuery.trim()) || s.command.includes(cmdQuery.trim())
      )
    : snippets;

  return (
    <div className="toolbar">
      <div className="toolbar__left">
        <span className={"ds-dot " + dotClass} />
        <span className="toolbar__conn-info">
          {session ? session.username + "@" + session.name : "—"}
        </span>
        <span className="toolbar__sep">·</span>
        <span className="toolbar__meta">
          {session ? session.host + ":" + session.port : ""}
        </span>
        <span className="toolbar__sep">·</span>
        <span className="toolbar__meta">
          {tab?.status === "connected" ? "已连接 3m" : tab?.status === "connecting" ? "连接中…" : "未连接"}
        </span>
      </div>
      <div className="toolbar__actions">
        {searchOpen && (
          <div className="toolbar__search">
            <input
              ref={searchRef}
              className="ds-input toolbar__search-input"
              value={query}
              placeholder="搜索终端内容…"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  doFind(e.shiftKey ? "prev" : "next");
                } else if (e.key === "Escape") {
                  setSearchOpen(false);
                  setQuery("");
                }
              }}
              spellCheck={false}
            />
            <button
              className="ds-btn ds-btn--tertiary ds-btn--icon"
              type="button"
              title="上一个"
              onClick={() => doFind("prev")}
            >
              <Icon name="chevron-up" size={13} />
            </button>
            <button
              className="ds-btn ds-btn--tertiary ds-btn--icon"
              type="button"
              title="下一个"
              onClick={() => doFind("next")}
            >
              <Icon name="chevron-down" size={13} />
            </button>
            <button
              className="ds-btn ds-btn--tertiary ds-btn--icon"
              type="button"
              title="关闭"
              onClick={() => {
                setSearchOpen(false);
                setQuery("");
              }}
            >
              <Icon name="x" size={13} />
            </button>
          </div>
        )}
        <button className="ds-btn ds-btn--secondary" type="button" onClick={() => void handleCopy()}>
          <Icon name="copy" size={13} />
          复制
        </button>
        <button className="ds-btn ds-btn--secondary" type="button" onClick={() => void toggleQuickCmd()}>
          <Icon name="terminal" size={13} />
          快捷命令
        </button>
        <button className="ds-btn ds-btn--secondary" type="button" onClick={handleSaveLog}>
          <Icon name="download" size={13} />
          保存日志
        </button>
        <button className="ds-btn ds-btn--secondary" type="button" onClick={handleClear}>
          <Icon name="trash" size={13} />
          清屏
        </button>
        <button
          className="ds-btn ds-btn--danger-subtle"
          type="button"
          onClick={handleDisconnect}
          disabled={!tab?.connectionId}
        >
          <Icon name="x-circle" size={13} />
          断开
        </button>
      </div>
      {cmdOpen && (
        <div
          className="toolbar__qc-backdrop"
          onClick={() => {
            setCmdOpen(false);
            setCmdEditing(null);
          }}
        >
          <div className="toolbar__qc-panel" onClick={(e) => e.stopPropagation()}>
            {cmdEditing ? (
              <>
                <div className="toolbar__qc-head">
                  <span className="toolbar__qc-title">填写变量：{cmdEditing.title}</span>
                  <button
                    className="ds-btn ds-btn--tertiary ds-btn--icon"
                    type="button"
                    onClick={() => setCmdEditing(null)}
                  >
                    <Icon name="x" size={13} />
                  </button>
                </div>
                <pre className="toolbar__qc-preview">{cmdEditing.command}</pre>
                {cmdEditing.vars.map((v) => (
                  <div className="form-row" key={v.name}>
                    <label>{v.name}</label>
                    <input
                      className="ds-input"
                      value={cmdEditing.values[v.name] ?? ""}
                      placeholder={`默认: ${v.defaultValue || "（空）"}`}
                      onChange={(e) =>
                        setCmdEditing({
                          ...cmdEditing,
                          values: { ...cmdEditing.values, [v.name]: e.target.value },
                        })
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void confirmQuickCmd();
                      }}
                    />
                  </div>
                ))}
                <div className="toolbar__qc-actions">
                  <button
                    className="ds-btn ds-btn--secondary"
                    type="button"
                    onClick={() => setCmdEditing(null)}
                  >
                    返回
                  </button>
                  <button
                    className="ds-btn ds-btn--brand"
                    type="button"
                    onClick={() => void confirmQuickCmd()}
                  >
                    执行
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="toolbar__qc-head">
                  <span className="toolbar__qc-title">快捷命令</span>
                  <button
                    className="ds-btn ds-btn--tertiary ds-btn--icon"
                    type="button"
                    onClick={() => {
                      setCmdOpen(false);
                      setCmdEditing(null);
                    }}
                  >
                    <Icon name="x" size={13} />
                  </button>
                </div>
                <input
                  ref={cmdSearchRef}
                  className="ds-input toolbar__qc-search"
                  value={cmdQuery}
                  placeholder="搜索命令…"
                  spellCheck={false}
                  onChange={(e) => setCmdQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      setCmdOpen(false);
                      setCmdEditing(null);
                    }
                  }}
                />
                <div className="toolbar__qc-list">
                  {filteredSnippets.length === 0 && (
                    <div className="toolbar__qc-empty">暂无匹配的片段，可在“命令片段”中创建</div>
                  )}
                  {filteredSnippets.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className="toolbar__qc-item"
                      onClick={() => void runSnippet(s)}
                    >
                      <span className="toolbar__qc-item-title">{s.title}</span>
                      <span className="toolbar__qc-item-cmd">{s.command}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
