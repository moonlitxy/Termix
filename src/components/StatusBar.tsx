import { useApp } from "../store/app";

export function StatusBar() {
  const tabs = useApp((s) => s.tabs);
  const activeTabId = useApp((s) => s.activeTabId);
  const activeTab = tabs.find((t) => t.id === activeTabId && !t.hidden);
  const connected = activeTab?.status === "connected";
  const connecting = activeTab?.status === "connecting";
  const statusText = connecting ? "连接中" : connected ? "已连接" : "未连接";
  const statusClass = connecting
    ? "ds-dot--warning"
    : connected
      ? "ds-dot--success"
      : "ds-dot--muted";

  return (
    <div className="status-bar">
      <div className="status-bar__left">
        <span className="status-bar__item">
          <span className={"ds-dot " + statusClass} />
          {statusText}
        </span>
        <span className="status-bar__item">UTF-8</span>
        <span className="status-bar__item">SSH-2</span>
      </div>
      <div className="status-bar__right">
        <span className="status-bar__shortcut">
          终端 <span className="ds-kbd">⌘T</span> 新建会话
        </span>
        <span className="status-bar__shortcut">
          断开 <span className="ds-kbd">⌘D</span>
        </span>
      </div>
    </div>
  );
}
