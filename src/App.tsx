import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { useApp } from "./store/app";
import { useMonitor, selectMonitorConnection } from "./store/monitor";
import { TitleBar } from "./components/TitleBar";
import { ActivityRail } from "./components/ActivityRail";
import { SessionSidebar } from "./components/SessionSidebar";
import { EditorTabs } from "./components/EditorTabs";
import { TerminalView } from "./components/TerminalView";
import { CommandInput } from "./components/CommandInput";
import { RightPanel } from "./components/RightPanel";
import { StatusBar } from "./components/StatusBar";
import { NewConnectionDialog } from "./components/NewConnectionDialog";
import { GlobalTooltip } from "./components/GlobalTooltip";
import { Icon } from "./components/Icon";
import { ipc, onTransferProgress } from "./lib/ipc";
import { terminalRegistry } from "./lib/terminalRegistry";

// 非终端视图按需加载（首屏不下载，减小初始 bundle）
// 组件为命名导出，转换为 default 供 lazy 使用
const SftpView = lazy(() => import("./components/SftpView").then((m) => ({ default: m.SftpView })));
const ForwardView = lazy(() =>
  import("./components/ForwardView").then((m) => ({ default: m.ForwardView }))
);
const SnippetsView = lazy(() =>
  import("./components/SnippetsView").then((m) => ({ default: m.SnippetsView }))
);
const MonitorView = lazy(() =>
  import("./components/MonitorView").then((m) => ({ default: m.MonitorView }))
);
const SettingsView = lazy(() =>
  import("./components/SettingsView").then((m) => ({ default: m.SettingsView }))
);

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
    // 以用户字号为基准，叠加视口自适应（窗口变化时字体随之缩放）
    const ui = (n: number) => `clamp(${n}px, calc(${n}px + 0.15vw), ${n + 4}px)`;
    document.documentElement.style.setProperty("--body-xs-font-size", ui(next - 3));
    document.documentElement.style.setProperty("--body-sm-font-size", ui(next - 2));
    document.documentElement.style.setProperty("--body-md-font-size", ui(next - 1));
    document.documentElement.style.setProperty("--body-base-font-size", ui(next));
    document.documentElement.style.setProperty("--code-terminal-font-size", ui(next - 1));
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

/** 懒加载视图的加载占位 */
function ViewLoading() {
  return (
    <div className="workspace__empty">
      <span className="workspace__empty-text">加载中…</span>
    </div>
  );
}

export default function App() {
  const tabs = useApp((s) => s.tabs);
  const activeTabId = useApp((s) => s.activeTabId);
  const activity = useApp((s) => s.activity);
  const sftpCollapsed = useApp((s) => s.sftpCollapsed);
  const sftpContext = useApp((s) => s.sftpContext);

  // 全局唯一监控轮询：跟随连接状态（终端右侧资源监控与「监控」模块共享同一数据源，
  // 由本组件统一驱动 useMonitor.sync，两处展示的数据完全一致）
  const monitorConnId = selectMonitorConnection(sftpContext, tabs);
  useEffect(() => {
    useMonitor.getState().sync(monitorConnId);
  }, [monitorConnId]);

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
          st.updateTab(tab.id, { status: "disconnected", manualClosed: true });
        }
      } else if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        adjustFontSize(1);
      } else if (e.key === "-") {
        e.preventDefault();
        adjustFontSize(-1);
      } else if (e.key.toLowerCase() === "f") {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent("termix:search"));
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // 切回终端视图或切换标签时恢复终端焦点：键盘输入与历史命令（↑↓）立即可用
  useEffect(() => {
    if (activity !== "terminal" || !activeTabId) return;
    const id = window.setTimeout(() => terminalRegistry.focus(activeTabId), 30);
    return () => window.clearTimeout(id);
  }, [activity, activeTabId]);

  const renderMain = () => {
    // 终端与文件（原 SFTP）已整合为统一模块：SSH 终端窗口与底部输入框常驻，
    // 底部面板（文件）展示远程文件系统，替代原连接信息工具栏。
    // 终端工作区始终挂载：切换到监控/设置等其他模块时仅隐藏（display:none）而不卸载，
    // 避免 xterm 实例被销毁导致切回后 SSH 会话输出与状态丢失。
    const isTerm = activity === "terminal" || activity === "sftp";
    let activityView: ReactNode = null;
    if (activity === "forward") {
      activityView = (
        <Suspense fallback={<ViewLoading />}>
          <ForwardView />
        </Suspense>
      );
    } else if (activity === "snippets") {
      activityView = (
        <Suspense fallback={<ViewLoading />}>
          <SnippetsView />
        </Suspense>
      );
    } else if (activity === "monitor") {
      activityView = (
        <Suspense fallback={<ViewLoading />}>
          <MonitorView />
        </Suspense>
      );
    } else if (activity === "settings") {
      activityView = (
        <Suspense fallback={<ViewLoading />}>
          <SettingsView />
        </Suspense>
      );
    } else if (!isTerm) {
      activityView = <Placeholder id={activity} />;
    }

    return (
      <>
        <div className={"workspace__terminal-stack" + (isTerm ? "" : " is-hidden")}>
          {hasTabs && <EditorTabs />}
          {hasTabs ? (
            <div className="workspace__main workspace__main--files">
              {tabs
                .filter((t) => !t.hidden)
                .map((tab) => {
                  // 分屏 pane 标签（兼容历史数据）：主标签 + 其 pane 标签并排渲染
                  const panes = tabs.filter((p) => p.splitOf === tab.id);
                  const isActive = tab.id === activeTabId;
                  if (panes.length === 0) {
                    return (
                      <div
                        key={tab.id}
                        className={
                          "workspace__terminal-slot" + (isActive ? " is-active" : "")
                        }
                      >
                        <TerminalView tab={tab} />
                      </div>
                    );
                  }
                  return (
                    <div
                      key={tab.id}
                      className={
                        "workspace__terminal-slot" + (isActive ? " is-active" : "")
                      }
                    >
                      <div className="workspace__split">
                        <div className="workspace__split-pane">
                          <TerminalView tab={tab} />
                        </div>
                        {panes.map((p) => (
                          <div className="workspace__split-pane" key={p.id}>
                            <TerminalView tab={p} />
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
            </div>
          ) : isTerm ? (
            activity === "sftp" ? (
              <Suspense fallback={<ViewLoading />}>
                <SftpView />
              </Suspense>
            ) : (
              <div className="workspace__empty">
                <span className="workspace__empty-logo">
                  <Icon name="logo" size={56} />
                </span>
                <div className="workspace__empty-text">双击左侧会话开始连接</div>
              </div>
            )
          ) : null}
          {hasTabs && (
            <div
              className={
                "workspace__sftp" + (sftpCollapsed ? " workspace__sftp--collapsed" : "")
              }
            >
              <Suspense fallback={<ViewLoading />}>
                <SftpView />
              </Suspense>
            </div>
          )}
          {hasTabs && <CommandInput />}
        </div>
        {!isTerm && activityView}
      </>
    );
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
      <GlobalTooltip />
    </div>
  );
}
