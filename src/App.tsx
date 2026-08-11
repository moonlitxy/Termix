import { useEffect } from "react";
import { useApp } from "./store/app";
import { TitleBar } from "./components/TitleBar";
import { ActivityRail } from "./components/ActivityRail";
import { SessionSidebar } from "./components/SessionSidebar";
import { EditorTabs } from "./components/EditorTabs";
import { TerminalView } from "./components/TerminalView";
import { Toolbar } from "./components/Toolbar";
import { CommandInput } from "./components/CommandInput";
import { RightPanel } from "./components/RightPanel";
import { StatusBar } from "./components/StatusBar";
import { NewConnectionDialog } from "./components/NewConnectionDialog";
import { SftpView } from "./components/SftpView";
import { ForwardView } from "./components/ForwardView";
import { SnippetsView } from "./components/SnippetsView";
import { MonitorView } from "./components/MonitorView";
import { SettingsView } from "./components/SettingsView";
import { Icon } from "./components/Icon";
import { ipc, onTransferProgress } from "./lib/ipc";
import { terminalRegistry } from "./lib/terminalRegistry";

const PLACEHOLDERS: Record<string, { icon: string; title: string }> = {
  plugins: { icon: "grid-2x2", title: "插件" },
  help: { icon: "help", title: "帮助" },
};

function adjustFontSize(delta: number) {
  try {
    const raw = localStorage.getItem("termix.settings");
    const settings = raw ? JSON.parse(raw) : { fontSize: 13 };
    const next = Math.min(18, Math.max(11, (settings.fontSize ?? 13) + delta));
    settings.fontSize = next;
    localStorage.setItem("termix.settings", JSON.stringify(settings));
    document.documentElement.style.setProperty("--code-terminal-font-size", next + "px");
    document.documentElement.style.setProperty("--body-base-font-size", next + "px");
    terminalRegistry.setFontSize(next);
  } catch {
    // ignore
  }
}

function Placeholder({ id }: { id: string }) {
  const p = PLACEHOLDERS[id] ?? { icon: "terminal", title: id };
  return (
    <div className="workspace__empty">
      <span className="workspace__empty-logo">
        <Icon name={p.icon} size={56} />
      </span>
      <div className="workspace__empty-text">{p.title}</div>
      <div className="workspace__empty-sub">该功能即将上线</div>
    </div>
  );
}

export default function App() {
  const tabs = useApp((s) => s.tabs);
  const activeTabId = useApp((s) => s.activeTabId);
  const activity = useApp((s) => s.activity);

  useEffect(() => {
    const st = useApp.getState();
    void st.loadSessions();
    void st.loadGroups();
    const unlistens: (() => void)[] = [];
    (async () => {
      try {
        const list = await ipc.transferList();
        useApp.getState().setTransfers(list);
      } catch {
        /* browser mode */
      }
      try {
        const un = await onTransferProgress((e) => {
          useApp.getState().upsertTransfer(e);
        });
        unlistens.push(un);
      } catch {
        /* browser mode */
      }
      try {
        const home = await ipc.localHome();
        useApp.setState({ localPath: home });
        void useApp.getState().loadLocal();
      } catch {
        /* browser mode */
      }
    })();
    return () => {
      unlistens.forEach((u) => u());
    };
  }, []);

  const hasTabs = tabs.length > 0;

  // 全局快捷键：⌘/Ctrl+T 新建连接、⌘/Ctrl+D 断开当前、Ctrl+/- 缩放终端字号
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key.toLowerCase() === "t") {
        e.preventDefault();
        useApp.getState().openNewConnection();
      } else if (e.key.toLowerCase() === "d") {
        e.preventDefault();
        const st = useApp.getState();
        const tab = st.tabs.find((t) => t.id === st.activeTabId);
        if (tab?.connectionId && tab.shellId) {
          void ipc.terminalDestroy(tab.connectionId, tab.shellId);
          void ipc.sessionDisconnect(tab.connectionId);
          st.updateTab(tab.id, { status: "disconnected" });
        }
      } else if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        adjustFontSize(1);
      } else if (e.key === "-") {
        e.preventDefault();
        adjustFontSize(-1);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const renderMain = () => {
    if (activity === "terminal") {
      return hasTabs ? (
        <>
          <EditorTabs />
          <div className="workspace__main">
            {tabs.map((tab) => (
              <div
                key={tab.id}
                className={
                  "workspace__terminal-slot" +
                  (tab.id === activeTabId ? " is-active" : "")
                }
              >
                <TerminalView tab={tab} />
              </div>
            ))}
          </div>
          <Toolbar />
          <CommandInput />
        </>
      ) : (
        <div className="workspace__empty">
          <span className="workspace__empty-logo">
            <Icon name="logo" size={56} />
          </span>
          <div className="workspace__empty-text">双击左侧会话开始连接</div>
        </div>
      );
    }
    if (activity === "sftp") {
      return <SftpView />;
    }
    if (activity === "forward") {
      return <ForwardView />;
    }
    if (activity === "snippets") {
      return <SnippetsView />;
    }
    if (activity === "monitor") {
      return <MonitorView />;
    }
    if (activity === "settings") {
      return <SettingsView />;
    }
    return <Placeholder id={activity} />;
  };

  return (
    <div className="app">
      <TitleBar />
      <div className="app__body">
        <ActivityRail />
        <SessionSidebar />
        <div className="workspace">{renderMain()}</div>
        <RightPanel />
      </div>
      <StatusBar />
      <NewConnectionDialog />
    </div>
  );
}
