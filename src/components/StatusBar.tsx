import { useApp } from "../store/app";
import { isWindowsPlatform } from "../lib/windowControls";
import { Icon } from "./Icon";
import { broadcastTargets } from "../lib/terminalBroadcast";
import { useT } from "../lib/i18n";
import { loadSettings, saveSettings } from "../lib/settings";

export function StatusBar() {
  const t = useT();
  const shortcutMod = isWindowsPlatform() ? "Ctrl" : "⌘";
  const tabs = useApp((s) => s.tabs);
  const activeTabId = useApp((s) => s.activeTabId);
  const transfers = useApp((s) => s.transfers);
  const transferWindowOpen = useApp((s) => s.transferWindowOpen);
  const setTransferWindowOpen = useApp((s) => s.setTransferWindowOpen);
  const broadcastInput = useApp((s) => s.broadcastInput);
  const toggleBroadcastInput = useApp((s) => s.toggleBroadcastInput);
  const activeTab = tabs.find((t) => t.id === activeTabId && !t.hidden);
  const connected = activeTab?.status === "connected";
  const connecting = activeTab?.status === "connecting";
  const statusText = connecting
    ? t("conn.connecting")
    : connected
      ? t("conn.connected")
      : t("conn.disconnected");
  const statusClass = connecting
    ? "ds-dot--warning"
    : connected
      ? "ds-dot--success"
      : "ds-dot--error";
  const activeTransfers = transfers.filter(
    (t) =>
      t.status === "running" || t.status === "paused" || t.status === "interrupted"
  ).length;
  const broadcastTargetsCount = activeTabId
    ? broadcastTargets(tabs, activeTabId).length
    : 0;

  const toggleTransfers = () => {
    const next = !transferWindowOpen;
    setTransferWindowOpen(next);
    saveSettings({ ...loadSettings(), transferWindowOpen: next });
  };

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
        <button
          className={
            "status-bar__transfer" + (broadcastInput ? " is-active" : "")
          }
          type="button"
          title={
            broadcastInput
              ? t("statusbar.broadcastOn", { n: broadcastTargetsCount })
              : t("statusbar.broadcastOff")
          }
          aria-pressed={broadcastInput}
          onClick={() => toggleBroadcastInput()}
        >
          <Icon name="send" size={11} />
          {t("statusbar.broadcast")}
          {broadcastInput && broadcastTargetsCount > 0 && (
            <span className="status-bar__transfer-count">{broadcastTargetsCount}</span>
          )}
        </button>
        <button
          className={
            "status-bar__transfer" + (transferWindowOpen ? " is-active" : "")
          }
          type="button"
          title={t("statusbar.resourcesTitle")}
          aria-pressed={transferWindowOpen}
          onClick={toggleTransfers}
        >
          <Icon name="bar" size={11} />
          {t("statusbar.resources")}
          {activeTransfers > 0 && (
            <span className="status-bar__transfer-count">{activeTransfers}</span>
          )}
        </button>
        <span className="status-bar__shortcut">
          {t("statusbar.terminal")} <span className="ds-kbd">{shortcutMod}T</span> {t("statusbar.newSession")}
        </span>
        <span className="status-bar__shortcut">
          {t("statusbar.disconnect")} <span className="ds-kbd">{shortcutMod}D</span>
        </span>
      </div>
    </div>
  );
}
