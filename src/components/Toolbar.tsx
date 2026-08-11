import { Icon } from "./Icon";
import { useApp } from "../store/app";
import { ipc } from "../lib/ipc";
import { terminalRegistry } from "../lib/terminalRegistry";

export function Toolbar() {
  const activeTabId = useApp((s) => s.activeTabId);
  const tabs = useApp((s) => s.tabs);
  const sessions = useApp((s) => s.sessions);
  const updateTab = useApp((s) => s.updateTab);

  const tab = tabs.find((t) => t.id === activeTabId);
  const session = tab ? sessions.find((s) => s.id === tab.sessionId) : undefined;

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
        <button className="ds-btn ds-btn--secondary" type="button" onClick={() => void handleCopy()}>
          <Icon name="copy" size={13} />
          复制
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
    </div>
  );
}
