import { useApp } from "../store/app";
import { isWindowsPlatform } from "../lib/windowControls";
import { Icon } from "./Icon";

export function StatusBar() {
  const shortcutMod = isWindowsPlatform() ? "Ctrl" : "⌘";
  const tabs = useApp((s) => s.tabs);
  const activeTabId = useApp((s) => s.activeTabId);
  const remotePath = useApp((s) => s.remotePath);
  const transfers = useApp((s) => s.transfers);
  const rightPanelExpanded = useApp((s) => s.rightPanelExpanded);
  const setRightPanelExpanded = useApp((s) => s.setRightPanelExpanded);
  const activeTab = tabs.find((t) => t.id === activeTabId && !t.hidden);
  const connected = activeTab?.status === "connected";
  const connecting = activeTab?.status === "connecting";
  const statusText = connecting ? "连接中" : connected ? "已连接" : "未连接";
  const statusClass = connecting
    ? "ds-dot--warning"
    : connected
      ? "ds-dot--success"
      : "ds-dot--muted";
  const activeTransfers = transfers.filter(
    (t) => t.status === "running" || t.status === "paused"
  ).length;

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
      <div className="status-bar__center" title={connected ? remotePath : undefined}>
        {connected ? remotePath : ""}
      </div>
      <div className="status-bar__right">
        <button
          className={
            "status-bar__transfer" + (rightPanelExpanded ? " is-active" : "")
          }
          type="button"
          title="打开传输队列"
          aria-pressed={rightPanelExpanded}
          onClick={() => setRightPanelExpanded(!rightPanelExpanded)}
        >
          <Icon name="arrow-right-to-line" size={11} />
          传输
          {activeTransfers > 0 && (
            <span className="status-bar__transfer-count">{activeTransfers}</span>
          )}
        </button>
        <span className="status-bar__shortcut">
          终端 <span className="ds-kbd">{shortcutMod}T</span> 新建会话
        </span>
        <span className="status-bar__shortcut">
          断开 <span className="ds-kbd">{shortcutMod}D</span>
        </span>
      </div>
    </div>
  );
}
