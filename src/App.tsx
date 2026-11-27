import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useApp } from "./store/app";
import { t as translate, useT } from "./lib/i18n";
import { useMonitor, selectMonitorConnection } from "./store/monitor";
import { ActivityRail } from "./components/ActivityRail";
import { TitleBar } from "./components/TitleBar";
import { SessionSidebar } from "./components/SessionSidebar";
import { EditorTabs } from "./components/EditorTabs";
import { TerminalView } from "./components/TerminalView";
import { CommandInput } from "./components/CommandInput";
import { TransferWindow } from "./components/TransferWindow";
import { StatusBar } from "./components/StatusBar";
import { NewConnectionDialog } from "./components/NewConnectionDialog";
import { UpdateDialog } from "./components/UpdateDialog";
import { GlobalTooltip } from "./components/GlobalTooltip";
import { FeedbackHost } from "./components/FeedbackHost";
import { CommandPalette } from "./components/CommandPalette";
import { AuthPromptHost } from "./components/AuthPromptHost";
import { Icon } from "./components/Icon";
import {
  ipc,
  onTransferProgress,
  onUpdateDownloadDone,
  onUpdateDownloadError,
  onUpdateDownloadProgress,
} from "./lib/ipc";
import {
  TERMINAL_FOCUS_CHANGED_EVENT,
  terminalRegistry,
} from "./lib/terminalRegistry";
import { appShortcutKey, isAppShortcut, isZoomShortcut } from "./lib/shortcuts";
import { useUpdate } from "./store/update";
import { toast } from "./store/feedback";
import { selectWorkspaceTargetTab } from "./lib/workspaceTarget";
import {
  applyAppearance,
  loadSettings,
  saveSettings,
  SETTINGS_CHANGE_EVENT,
} from "./lib/settings";

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
const HelpView = lazy(() =>
  import("./components/HelpView").then((m) => ({ default: m.HelpView }))
);

const PLACEHOLDERS: Record<string, { icon: string; title: string }> = {
  plugins: { icon: "grid-2x2", title: "插件" },
};

function adjustFontSize(delta: number) {
  try {
    const settings = loadSettings();
    const fontSize = Math.min(18, Math.max(11, settings.fontSize + delta));
    saveSettings({ ...settings, fontSize });
  } catch {
    // ignore
  }
}

function Placeholder({ id }: { id: string }) {
  const t = useT();
  const p = PLACEHOLDERS[id] ?? { icon: "terminal", title: id };
  const title = id === "plugins" ? t("app.plugins") : p.title;
  return (
    <div className="workspace__empty">
      <span className="workspace__empty-logo">
        <Icon name={p.icon} size={24} />
      </span>
      <div className="workspace__empty-text">{title}</div>
      <div className="workspace__empty-sub">{t("app.comingSoon")}</div>
    </div>
  );
}

/** 懒加载视图的加载占位 */
function ViewLoading() {
  const t = useT();
  return (
    <div className="view-skeleton" role="status" aria-label={t("app.loading")}>
      <div className="view-skeleton__toolbar" />
      <div className="view-skeleton__grid">
        {[0, 1, 2, 3].map((item) => (
          <div className="view-skeleton__card" key={item}>
            <span className="view-skeleton__line view-skeleton__line--short" />
            <span className="view-skeleton__line" />
            <span className="view-skeleton__line view-skeleton__line--medium" />
          </div>
        ))}
      </div>
    </div>
  );
}

export default function App() {
  const t = useT();
  const tabs = useApp((s) => s.tabs);
  const transfers = useApp((s) => s.transfers);
  const activeTabId = useApp((s) => s.activeTabId);
  const activity = useApp((s) => s.activity);
  const sftpCollapsed = useApp((s) => s.sftpCollapsed);
  const sftpContext = useApp((s) => s.sftpContext);
  const stackRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<{ startY: number; startRatio: number } | null>(null);
  const [panelResizing, setPanelResizing] = useState(false);
  const [sftpRatio, setSftpRatio] = useState(() =>
    Math.min(0.8, Math.max(0.15, loadSettings().sftpPanelRatio || 0.4))
  );

  const startSftpResize = (e: React.PointerEvent) => {
    if (sftpCollapsed || !stackRef.current) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setPanelResizing(true);
    dragStateRef.current = {
      startY: e.clientY,
      startRatio: sftpRatio,
    };
  };

  const moveSftpResize = (e: React.PointerEvent) => {
    const drag = dragStateRef.current;
    const stack = stackRef.current;
    if (!drag || !stack) return;
    const delta = (e.clientY - drag.startY) / Math.max(1, stack.clientHeight);
    setSftpRatio(
      // sftpRatio 表示下方文件面板占比：向下拖拽应缩小文件面板、放大终端
      Math.min(0.8, Math.max(0.15, drag.startRatio - delta))
    );
  };

  const endSftpResize = () => {
    if (!dragStateRef.current) return;
    dragStateRef.current = null;
    setPanelResizing(false);
    setSftpRatio((ratio) => {
      saveSettings({ ...loadSettings(), sftpPanelRatio: ratio });
      return ratio;
    });
  };

  const adjustSftpRatio = (delta: number) => {
    setSftpRatio((current) => {
      const ratio = Math.min(0.8, Math.max(0.15, current + delta));
      saveSettings({ ...loadSettings(), sftpPanelRatio: ratio });
      return ratio;
    });
  };

  // Theme and typography are application-wide; apply saved changes live.
  useEffect(() => {
    const sync = () => applyAppearance(loadSettings());
    sync();
    window.addEventListener(SETTINGS_CHANGE_EVENT, sync);
    return () => {
      window.removeEventListener(SETTINGS_CHANGE_EVENT, sync);
    };
  }, []);

  // 恢复用户上次手动开关的悬浮传输窗状态（自动弹出不会改写这个偏好）
  useEffect(() => {
    useApp.setState({ transferWindowOpen: loadSettings().transferWindowOpen });
  }, []);

  // 文件面板跟随当前激活标签或分屏中最近聚焦的终端；上下文被清空时也会自动重绑。
  useEffect(() => {
    const syncSftpContext = () => {
      const st = useApp.getState();
      const target = selectWorkspaceTargetTab(
        st.tabs,
        st.activeTabId,
        terminalRegistry.getFocus()
      );
      if (target?.status === "connected" && target.connectionId) {
        if (st.sftpContext?.connectionId !== target.connectionId) {
          void st.setSftpContext(target.sessionId, target.connectionId);
        }
      } else if (st.sftpContext) {
        void st.setSftpContext(st.sftpContext.sessionId, null);
      }
    };
    syncSftpContext();
    window.addEventListener(TERMINAL_FOCUS_CHANGED_EVENT, syncSftpContext);
    return () =>
      window.removeEventListener(TERMINAL_FOCUS_CHANGED_EVENT, syncSftpContext);
  }, [activeTabId, tabs, sftpContext?.connectionId]);

  // 全局唯一监控轮询：跟随连接状态（终端右侧资源监控与「监控」模块共享同一数据源，
  // 由本组件统一驱动 useMonitor.sync，两处展示的数据完全一致）
  const monitorConnId = selectMonitorConnection(sftpContext, tabs, activeTabId);
  useLayoutEffect(() => {
    useMonitor.getState().sync(monitorConnId);
  }, [monitorConnId]);

  // 为其他已连接标签预取一份监控快照，切换时先显示旧数据再刷新。
  useEffect(() => {
    const connIds = tabs
      .filter((tab) => tab.status === "connected" && tab.connectionId)
      .map((tab) => tab.connectionId!);
    useMonitor.getState().prefetch(connIds);
  }, [tabs]);

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
          if (e.restarted) {
            toast.warning(translate("panel.restarted"));
          }
        });
        unlistens.push(un);
      } catch {
        /* browser mode */
      }
      try {
        const paths = await ipc.appPaths();
        useApp.getState().setAppPaths(paths);
        useApp.setState({ localPath: paths.downloadDir });
      } catch {
        // browser 模式或路径解析失败时回退到 home / 上次目录
        try {
          const home = await ipc.localHome();
          const saved = loadSettings().lastLocalPath;
          let localPath = home;
          if (saved) {
            try {
              await ipc.localList(saved);
              localPath = saved;
            } catch {
              // 保存的目录已失效时回退到 home
            }
          }
          useApp.setState({ localPath });
        } catch {
          /* browser mode */
        }
      }
    })();
    return () => {
      unlistens.forEach((u) => u());
    };
  }, []);

  // 新传输开始时自动展开右侧队列，避免用户看不到进度条；
  // 每个任务只触发一次，用户随后手动收起不会被反复打开。
  const autoOpenedTransfers = useRef(new Set<string>());
  useEffect(() => {
    const fresh = transfers.filter(
      (task) => task.status === "running" && !autoOpenedTransfers.current.has(task.id)
    );
    if (fresh.length === 0) return;
    fresh.forEach((task) => autoOpenedTransfers.current.add(task.id));
    if (!useApp.getState().transferWindowOpen) {
      useApp.getState().setTransferWindowOpen(true);
    }
  }, [transfers]);

  // 连接中断的传输在会话重连后自动续传（用户主动暂停的任务保持暂停）。
  const resumeAttempts = useRef<Record<string, number>>({});
  const resumeInFlight = useRef(new Set<string>());
  useEffect(() => {
    for (const task of transfers) {
      if (task.status !== "interrupted") {
        delete resumeAttempts.current[task.id];
        continue;
      }
      if (!task.sessionId) continue;
      if (resumeInFlight.current.has(task.id)) continue;
      const tab = tabs.find(
        (candidate) =>
          candidate.sessionId === task.sessionId &&
          candidate.status === "connected" &&
          !!candidate.connectionId
      );
      if (!tab?.connectionId) continue;
      // 必须等到重连产生新的 connectionId，避免在已失效的旧连接上重试
      if (task.connectionId && task.connectionId === tab.connectionId) continue;
      const attempts = resumeAttempts.current[task.id] ?? 0;
      if (attempts >= 3) continue;
      resumeAttempts.current[task.id] = attempts + 1;
      resumeInFlight.current.add(task.id);
      ipc
        .transferResume(task.id, tab.connectionId)
        .catch((e) => console.warn("[transfer] auto resume failed", e))
        .finally(() => {
          window.setTimeout(() => resumeInFlight.current.delete(task.id), 2000);
        });
    }
  }, [tabs, transfers]);

  // 软件更新：启动后延迟自动检查（不打断首次交互），并监听下载进度 / 完成 / 失败事件
  useEffect(() => {
    const t = window.setTimeout(() => {
      void useUpdate.getState().autoCheck();
    }, 4000);
    const unlistens: (() => void)[] = [];
    (async () => {
      try {
        const un = await onUpdateDownloadProgress((e) => {
          useUpdate.getState().setProgress(e);
        });
        unlistens.push(un);
      } catch {
        /* browser mode */
      }
      try {
        const un = await onUpdateDownloadDone((e) => {
          const st = useUpdate.getState();
          st.setDownloadDone(e.path);
          // 下载完成后自动安装：macOS 替换 .app 并重启，Windows 启动 NSIS 覆盖安装
          void ipc.installUpdate(e.path).catch((err) => st.setDownloadError(String(err)));
        });
        unlistens.push(un);
      } catch {
        /* browser mode */
      }
      try {
        const un = await onUpdateDownloadError((e) => {
          useUpdate.getState().setDownloadError(e.error);
        });
        unlistens.push(un);
      } catch {
        /* browser mode */
      }
    })();
    return () => {
      window.clearTimeout(t);
      unlistens.forEach((u) => u());
    };
  }, []);

  const hasTabs = tabs.length > 0;

  // 全局快捷键：macOS Cmd+key，Windows Ctrl+Shift+key，避免抢占终端控制键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isAppShortcut(e, "k")) {
        e.preventDefault();
        useApp.getState().openPalette();
      } else if (isAppShortcut(e, "t")) {
        e.preventDefault();
        useApp.getState().openNewConnection();
      } else if (isAppShortcut(e, "d")) {
        e.preventDefault();
        const st = useApp.getState();
        const tab = st.tabs.find((t) => t.id === st.activeTabId);
        if (tab?.connectionId && tab.shellId) {
          void ipc.terminalDestroy(tab.connectionId, tab.shellId);
          void ipc.sessionDisconnect(tab.connectionId);
          st.updateTab(tab.id, {
            status: "disconnected",
            connectionId: undefined,
            shellId: undefined,
          });
        }
      } else if (isZoomShortcut(e, "=") || isZoomShortcut(e, "+")) {
        e.preventDefault();
        adjustFontSize(1);
      } else if (isZoomShortcut(e, "-")) {
        e.preventDefault();
        adjustFontSize(-1);
      } else if (isAppShortcut(e, "f")) {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent("termix:search"));
      } else if (isAppShortcut(e, "l")) {
        e.preventDefault();
        useApp.getState().setCommandInputOpen(true);
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
    } else if (activity === "help") {
      activityView = (
        <Suspense fallback={<ViewLoading />}>
          <HelpView />
        </Suspense>
      );
    } else if (!isTerm) {
      activityView = <Placeholder id={activity} />;
    }

    return (
      <>
        <div
          ref={stackRef}
          className={
            "workspace__terminal-stack" +
            (isTerm ? "" : " is-hidden") +
            (panelResizing ? " is-panel-resizing" : "")
          }
        >
          <EditorTabs />
          {hasTabs ? (
            <div
              className="workspace__main workspace__main--files"
              // 收起时文件面板不再参与分配，终端必须吃掉全部剩余高度，
              // 否则 flex-grow 总和小于 1 会在底部留下空白。
              style={{ flexGrow: sftpCollapsed ? 1 : 1 - sftpRatio }}
            >
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
                  <Icon name="terminal" size={28} />
                </span>
                <div className="workspace__empty-text">{t("app.emptyTitle")}</div>
                <div className="workspace__empty-sub">{t("app.emptySub")}</div>
                <button
                  className="ds-btn ds-btn--brand workspace__empty-btn"
                  type="button"
                  onClick={() => useApp.getState().openNewConnection()}
                >
                  <Icon name="plus" size={14} />
                  {t("session.newConnTitle")}
                </button>
                <div className="workspace__empty-shortcut">
                  <span className="ds-kbd">{appShortcutKey("T")}</span>{" "}
                  {t("app.quickNew")}
                </div>
              </div>
            )
          ) : null}
          {hasTabs && !sftpCollapsed && (
            <div
              className="workspace__panel-resizer"
              role="separator"
              aria-orientation="horizontal"
              aria-label={t("app.resizePanel")}
              tabIndex={0}
              aria-valuenow={Math.round(sftpRatio * 100)}
              aria-valuemin={15}
              aria-valuemax={80}
              onPointerDown={startSftpResize}
              onPointerMove={moveSftpResize}
              onPointerUp={endSftpResize}
              onPointerCancel={endSftpResize}
              onLostPointerCapture={endSftpResize}
              onKeyDown={(e) => {
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  adjustSftpRatio(0.02);
                } else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  adjustSftpRatio(-0.02);
                }
              }}
            />
          )}
          {hasTabs && (
            <div
              className={
                "workspace__sftp" + (sftpCollapsed ? " workspace__sftp--collapsed" : "")
              }
              style={
                sftpCollapsed
                  ? undefined
                  : { flexGrow: sftpRatio, flexShrink: 1, flexBasis: 0 }
              }
            >
              <Suspense fallback={<ViewLoading />}>
                <SftpView />
              </Suspense>
            </div>
          )}
          <CommandInput />
        </div>
        {!isTerm && (
          <div className="workspace__activity" key={activity}>
            {activityView}
          </div>
        )}
      </>
    );
  };

  return (
    <div className="app">
      <div className="app__body">
        <TitleBar />
        <div className="app__main-row">
          <ActivityRail />
          <SessionSidebar />
          <div className="workspace-shell">
            <div className="workspace">{renderMain()}</div>
            <TransferWindow />
          </div>
        </div>
      </div>
      <StatusBar />
      <CommandPalette />
      <NewConnectionDialog />
      <UpdateDialog />
      <FeedbackHost />
      <AuthPromptHost />
      <GlobalTooltip />
    </div>
  );
}
