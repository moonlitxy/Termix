import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { Icon } from "./Icon";
import { useApp } from "../store/app";
import { ipc, onTerminalOutput, onConnectionStatus, HISTORY_CHANGED_EVENT } from "../lib/ipc";
import { terminalRegistry } from "../lib/terminalRegistry";
import { confirmDialog } from "../store/feedback";
import { loadSettings, SETTINGS_CHANGE_EVENT } from "../lib/settings";
import { broadcastTargets } from "../lib/terminalBroadcast";
import { backendError, useT } from "../lib/i18n";
import {
  terminalBufferToText,
  terminalLogFileName,
} from "../lib/terminalLog";
import type { Tab } from "../types";

/** 正在建立连接的标签集合：防止同一标签并发发起多次 SSH 连接 */
const connectingTabs = new Set<string>();

const TERMINAL_THEME = {
  background: "#0c0c0c",
  foreground: "#cccccc",
  cursor: "#3fb950",
  cursorAccent: "#0c0c0c",
  selectionBackground: "rgba(63,185,80,0.28)",
  black: "#0c0c0c",
  red: "#f85149",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#58a6ff",
  magenta: "#bc8cff",
  cyan: "#39c5cf",
  white: "#cccccc",
  brightBlack: "#6e7681",
  brightRed: "#ff7b72",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#56d4dd",
  brightWhite: "#f0f6fc",
};

export function TerminalView({ tab }: { tab: Tab }) {
  const tr = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const tabRef = useRef<Tab>(tab);
  const hasSelectionRef = useRef(false);
  const [retryKey, setRetryKey] = useState(0);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [pastePending, setPastePending] = useState<string | null>(null);

  const updateTab = useApp((s) => s.updateTab);
  // 重连请求计数：标题栏重连按钮触发后递增，驱动终端重建连接
  const reconnectNonce = useApp((s) => s.reconnectNonce[tab.id] ?? 0);

  // 始终保持 tabRef 指向最新的 tab
  tabRef.current = tab;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    const unlisteners: UnlistenFn[] = [];
    let ro: ResizeObserver | null = null;
    let resizeTimer: number | undefined;
    let prefs = loadSettings();

    const terminal = new Terminal({
      fontFamily: "JetBrains Mono, SF Mono, Menlo, monospace",
      fontSize: Math.max(11, prefs.fontSize - 1),
      lineHeight: 1.5,
      cursorBlink: true,
      cursorStyle: prefs.cursorStyle,
      scrollback: prefs.scrollback,
      theme: TERMINAL_THEME,
      allowProposedApi: true,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    const searchAddon = new SearchAddon();
    terminal.loadAddon(searchAddon);
    terminal.open(container);
    termRef.current = terminal;
    fitRef.current = fitAddon;
    terminalRegistry.set(tab.id, terminal);
    terminalRegistry.setSearch(tab.id, searchAddon);

    try {
      fitAddon.fit();
    } catch {
      // 容器可能尚未布局，忽略
    }
    // 进入终端视图时立即聚焦，恢复键盘输入（切换自 SFTP 等模块后无需手动点击）
    terminal.focus();

    const writeClipboardText = async (text: string) => {
      const current = tabRef.current;
      if (!current.connectionId || !current.shellId) return;
      try {
        await ipc.terminalWrite(current.connectionId, current.shellId, text);
      } catch (e) {
        console.error("terminal clipboard write failed:", e);
      }
    };
    const copySelection = async () => {
      const selection = terminal.getSelection();
      if (!selection) return;
      try {
        await navigator.clipboard.writeText(selection);
      } catch (e) {
        console.error("terminal copy failed:", e);
      }
      terminal.focus();
    };
    const pasteClipboard = async () => {
      let text = "";
      try {
        text = await navigator.clipboard.readText();
      } catch (e) {
        console.error("terminal paste read failed:", e);
        return;
      }
      if (!text) return;
      if (text.includes("\n")) {
        setPastePending(text);
      } else {
        await writeClipboardText(text);
      }
      terminal.focus();
    };
    // 终端内标准复制/粘贴快捷键（macOS Cmd+C/V，Windows/Linux Ctrl+C/V 或 Ctrl+Shift+C/V）
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      if (!event.metaKey && !event.ctrlKey) return true;
      const key = event.key.toLowerCase();
      if (key === "c" && terminal.hasSelection()) {
        event.preventDefault();
        void copySelection();
        return false;
      }
      if (key === "v") {
        event.preventDefault();
        void pasteClipboard();
        return false;
      }
      return true;
    });

    // 订阅终端输出
    onTerminalOutput((e) => {
      if (e.tabId === tab.id && !cancelled) {
        terminal.write(e.data);
      }
    }).then((un) => {
      if (cancelled) un();
      else unlisteners.push(un);
    });

    // 自动重连：意外断开后最多重试 3 次（用户手动断开不会触发）
    let reconnectCount = 0;
    let reconnecting = false;
    const doReconnect = async () => {
      if (cancelled || reconnecting) return;
      // 手动断开（断开按钮 / ⌘D）：不自动重连
      if (tabRef.current.manualClosed) return;
      if (reconnectCount >= 3) {
        terminal.write(`\r\n\x1b[31m${tr("term.reconnectFailed")}\x1b[0m\r\n`);
        return;
      }
      reconnecting = true;
      reconnectCount += 1;
      terminal.write(`\r\n连接断开，2 秒后自动重连（第 ${reconnectCount}/3 次）...\r\n`);
      await new Promise((r) => setTimeout(r, 2000));
      if (cancelled) {
        reconnecting = false;
        return;
      }
      const cur = tabRef.current;
      try {
        const connId = await ipc.sessionConnect(cur.sessionId);
        const shellId = await ipc.terminalCreate(
          connId,
          cur.id,
          terminal.cols,
          terminal.rows
        );
        updateTab(cur.id, {
          connectionId: connId,
          shellId,
          status: "connected",
          manualClosed: false,
        });
        reconnectCount = 0;
        reconnecting = false;
        terminal.write(`\x1b[32m${tr("term.reconnected")}\x1b[0m\r\n`);
      } catch (e) {
        terminal.write(`\x1b[31m重连失败: ${String(e)}\x1b[0m\r\n`);
        reconnecting = false;
        void doReconnect();
      }
    };

    // 订阅连接状态
    onConnectionStatus((e) => {
      if (e.tabId === tab.id && e.status === "closed" && !cancelled) {
        updateTab(tab.id, { status: "disconnected" });
        void doReconnect();
      }
    }).then((un) => {
      if (cancelled) un();
      else unlisteners.push(un);
    });

    // 用户输入回传后端；同时跟踪当前命令行，回车时写入历史，
    // 使终端直接输入的命令与底部输入框/历史按钮共用同一份历史（双向同步）
    let cmdLine = "";
    const dataDisp = terminal.onData((data) => {
      const t = tabRef.current;
      if (data.startsWith("\x1b")) {
        // ESC 开头为控制序列（方向键等），重置当前行跟踪，避免误拼
        cmdLine = "";
      } else {
        for (const ch of data) {
          if (ch === "\r" || ch === "\n") {
            const cmd = cmdLine.trim();
            if (cmd && t.sessionId) {
              ipc.historyAdd(t.sessionId, cmd).catch(() => {});
              document.dispatchEvent(new CustomEvent(HISTORY_CHANGED_EVENT));
            }
            cmdLine = "";
          } else if (ch === "\u007f" || ch === "\b") {
            // 退格
            cmdLine = cmdLine.slice(0, -1);
          } else if (ch === "\u0003") {
            // Ctrl+C：中断当前行
            cmdLine = "";
          } else if (ch === "\u0015") {
            // Ctrl+U：清空当前行
            cmdLine = "";
          } else if (ch === "\u0017") {
            // Ctrl+W：删除最后一个词
            cmdLine = cmdLine.replace(/\s*\S+\s*$/, "");
          } else if (ch >= " " && ch !== "\u001b") {
            cmdLine += ch;
          }
        }
      }
      if (t.connectionId && t.shellId) {
        ipc.terminalWrite(t.connectionId, t.shellId, data);
      }
      // 同步输入：开启后把同一份输入写到其他已连接标签（含分屏），
      // 各目标独立发送、互不等待，某一路失败不影响其他路
      if (useApp.getState().broadcastInput) {
        const targets = broadcastTargets(useApp.getState().tabs, tab.id);
        for (const target of targets) {
          ipc.terminalWrite(target.connectionId, target.shellId, data).catch(() => {});
        }
      }
    });

    // 记录最近聚焦的终端（分屏 pane 无法被激活，搜索等操作以此为目标）
    const onContainerDown = () => terminalRegistry.setFocus(tab.id);
    const onContainerFocusIn = () => terminalRegistry.setFocus(tab.id);
    container.addEventListener("pointerdown", onContainerDown);
    container.addEventListener("focusin", onContainerFocusIn);

    // 跟踪选中状态，供右键菜单判断"复制"是否可用
    const selDisp = terminal.onSelectionChange(() => {
      hasSelectionRef.current = terminal.hasSelection();
    });

    // 容器尺寸变化
    ro = new ResizeObserver(() => {
      if (cancelled) return;
      // 隐藏的 tab 容器尺寸为 0，跳过 fit 避免破坏终端尺寸
      if (container.offsetWidth === 0 || container.offsetHeight === 0) return;
      window.clearTimeout(resizeTimer);
      // 面板折叠/窗口拖动会连续触发尺寸变化，等布局稳定后只 fit 一次
      resizeTimer = window.setTimeout(() => {
        if (cancelled) return;
        if (container.offsetWidth === 0 || container.offsetHeight === 0) return;
        try {
          fitAddon.fit();
          const t = tabRef.current;
          if (t.connectionId && t.shellId && terminal.cols > 0 && terminal.rows > 0) {
            ipc.terminalResize(t.connectionId, t.shellId, terminal.cols, terminal.rows);
          }
        } catch {
          // 忽略
        }
      }, 80);
    });
    ro.observe(container);

    const onSettingsChange = () => {
      const next = loadSettings();
      if (
        next.fontSize === prefs.fontSize &&
        next.scrollback === prefs.scrollback &&
        next.cursorStyle === prefs.cursorStyle
      ) {
        return;
      }
      prefs = next;
      terminal.options.fontSize = Math.max(11, next.fontSize - 1);
      terminal.options.scrollback = next.scrollback;
      terminal.options.cursorStyle = next.cursorStyle;
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        if (cancelled) return;
        try {
          fitAddon.fit();
          const t = tabRef.current;
          if (t.connectionId && t.shellId) {
            ipc.terminalResize(t.connectionId, t.shellId, terminal.cols, terminal.rows);
          }
        } catch {
          // ignore
        }
      }, 50);
    };
    window.addEventListener(SETTINGS_CHANGE_EVENT, onSettingsChange);

    // 连接流程（仅未连接时；同标签并发连接保护）
    const connect = async () => {
      const current = tabRef.current;
      if (current.connectionId) return;
      if (connectingTabs.has(tab.id)) return;
      connectingTabs.add(tab.id);
      terminal.write("Connecting to host...\r\n");
      try {
        const connId = await ipc.sessionConnect(tab.sessionId);
        if (cancelled) {
          // 已卸载，清理这条连接
          try {
            await ipc.terminalDestroy(connId, "");
          } catch {
            // ignore
          }
          return;
        }
        const shellId = await ipc.terminalCreate(
          connId,
          tab.id,
          terminal.cols,
          terminal.rows
        );
        if (cancelled) {
          try {
            await ipc.terminalDestroy(connId, shellId);
          } catch {
            // ignore
          }
          return;
        }
        updateTab(tab.id, {
          connectionId: connId,
          shellId,
          status: "connected",
          manualClosed: false,
        });
      } catch (e) {
        if (cancelled) return;
        const msg = String(e);
        const session = useApp
          .getState()
          .sessions.find((s) => s.id === tab.sessionId);

        // 首次连接：主机密钥未信任，请求用户确认指纹后重试
        const unverified = msg.match(/^HOST_KEY_UNVERIFIED:(.+)$/);
        if (unverified && session) {
          const fingerprint = unverified[1];
          const ok = await confirmDialog({
            title: tr("term.hostKeyTitle"),
            message: tr("term.hostKeyMsg", {
              host: session.host,
              port: session.port,
              fp: fingerprint,
            }),
            confirmText: tr("term.trustConnect"),
          });
          if (ok) {
            try {
              await ipc.hostKeyAccept(session.host, session.port, fingerprint);
              connectingTabs.delete(tab.id);
              void connect();
            } catch (e2) {
              updateTab(tab.id, {
                status: "error",
                error: tr("term.saveHostKeyFailed", { e: String(e2) }),
              });
            }
            return;
          }
          updateTab(tab.id, {
            status: "error",
            error: tr("term.cancelledNoTrust"),
          });
          return;
        }

        // 主机密钥变更：可能中间人攻击，需二次确认才允许覆盖信任
        const changed = msg.match(/^HOST_KEY_CHANGED:(.+):(.+)$/);
        if (changed && session) {
          updateTab(tab.id, { status: "error", error: tr("term.hostKeyChangedBlocked") });
          const warn = await confirmDialog({
            title: tr("term.hostKeyWarnTitle"),
            message: tr("term.hostKeyWarnMsg", {
              host: session.host,
              port: session.port,
              cur: changed[1],
              prev: changed[2],
            }),
            confirmText: tr("term.continueCheck"),
            danger: true,
          });
          if (warn) {
            const sure = await confirmDialog({
              title: tr("term.confirmAgain"),
              message: tr("term.trustReconnectMsg"),
              confirmText: tr("term.trustReconnect"),
              danger: true,
            });
            if (sure) {
              try {
                await ipc.hostKeyAccept(session.host, session.port, changed[1]);
                connectingTabs.delete(tab.id);
                void connect();
                return;
              } catch (e2) {
                updateTab(tab.id, { status: "error", error: String(e2) });
                return;
              }
            }
          }
          terminal.write(tr("term.hostKeyMismatch"));
          return;
        }

        const errText = backendError(String(e));
        updateTab(tab.id, { status: "error", error: errText });
        terminal.write("Error: " + errText + "\r\n");
      } finally {
        connectingTabs.delete(tab.id);
      }
    };
    void connect();

    return () => {
      cancelled = true;
      dataDisp.dispose();
      container.removeEventListener("pointerdown", onContainerDown);
      container.removeEventListener("focusin", onContainerFocusIn);
      window.removeEventListener(SETTINGS_CHANGE_EVENT, onSettingsChange);
      selDisp.dispose();
      unlisteners.forEach((un) => un());
      window.clearTimeout(resizeTimer);
      if (ro) ro.disconnect();
      // 仅销毁终端；连接断开由 EditorTabs / 文件面板「断开」负责
      const t = tabRef.current;
      if (t.connectionId && t.shellId) {
        ipc.terminalDestroy(t.connectionId, t.shellId).catch(() => {});
      }
      terminal.dispose();
      termRef.current = null;
      fitRef.current = null;
      terminalRegistry.remove(tab.id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, retryKey, reconnectNonce]);

  const handleRetry = () => {
    updateTab(tab.id, {
      status: "connecting",
      connectionId: undefined,
      shellId: undefined,
      error: undefined,
    });
    setRetryKey((k) => k + 1);
  };

  // ---- 右键菜单 ----
  const sendText = async (text: string) => {
    const cur = tabRef.current;
    if (!cur.connectionId || !cur.shellId) return;
    try {
      await ipc.terminalWrite(cur.connectionId, cur.shellId, text);
    } catch (e) {
      console.error("terminal write failed:", e);
    }
  };

  const openCtxMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const menuW = 140;
    const menuH = 180;
    setCtxMenu({
      x: Math.max(4, Math.min(e.clientX - rect.left, rect.width - menuW - 4)),
      y: Math.max(4, Math.min(e.clientY - rect.top, rect.height - menuH - 4)),
    });
  };

  const closeCtxMenu = () => setCtxMenu(null);

  const handleCopy = async () => {
    const t = termRef.current;
    const sel = t ? t.getSelection() : "";
    if (sel) {
      try {
        await navigator.clipboard.writeText(sel);
      } catch (e) {
        console.error("copy failed:", e);
      }
    }
    closeCtxMenu();
    t?.focus();
  };

  const handlePaste = async () => {
    const t = termRef.current;
    closeCtxMenu();
    t?.focus();
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch (e) {
      console.error("read clipboard failed:", e);
      return;
    }
    if (!text) return;
    // 多行内容需要用户确认，避免误粘贴破坏终端状态
    if (text.includes("\n")) {
      setPastePending(text);
    } else {
      void sendText(text);
    }
  };

  const handleClear = () => {
    const t = termRef.current;
    if (t) {
      t.clear();
      t.clearSelection();
      t.focus();
    }
    closeCtxMenu();
  };

  const handleSaveLog = () => {
    const t = termRef.current;
    if (!t) return;
    const text = terminalBufferToText(t.buffer.active);
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = terminalLogFileName(tabRef.current.title);
    anchor.click();
    // 延迟释放对象 URL：避免部分 WebView 在下载开始前回收导致保存失败
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    closeCtxMenu();
    t.focus();
  };

  // 查找：复用工具栏的终端内搜索（Ctrl+F 同一入口）
  const handleFind = () => {
    closeCtxMenu();
    document.dispatchEvent(new CustomEvent("termix:search"));
  };

  const confirmPaste = () => {
    if (pastePending) void sendText(pastePending);
    setPastePending(null);
  };

  const cancelPaste = () => setPastePending(null);

  // 分屏 pane 关闭按钮：销毁连接并关闭该 pane 标签
  const closePane = async () => {
    const t = tabRef.current;
    try {
      if (t.connectionId && t.shellId) {
        await ipc.terminalDestroy(t.connectionId, t.shellId);
      }
      if (t.connectionId) {
        await ipc.sessionDisconnect(t.connectionId);
      }
    } catch {
      // 忽略关闭时的错误
    }
    useApp.getState().closeTab(t.id);
  };

  return (
    <div className="terminal-view">
      <div
        className="terminal-view__container"
        ref={containerRef}
        onContextMenu={openCtxMenu}
      />
      {tab.hidden && (
        <button
          type="button"
          className="terminal-view__close-pane"
          title={tr("term.closeSplit")}
          onClick={() => void closePane()}
        >
          <Icon name="x" size={12} />
        </button>
      )}
      {ctxMenu && (
        <div
          className="terminal-view__ctx-backdrop"
          onClick={closeCtxMenu}
          onContextMenu={(e) => {
            e.preventDefault();
            closeCtxMenu();
          }}
        >
          <div
            className="terminal-view__ctx-menu"
            style={{ left: ctxMenu.x, top: ctxMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="terminal-view__ctx-item"
              title={tr("term.copySel")}
              disabled={!hasSelectionRef.current}
              onClick={handleCopy}
            >
              复制
            </button>
            <button
              type="button"
              className="terminal-view__ctx-item"
              title={tr("term.paste")}
              onClick={handlePaste}
            >
              粘贴
            </button>
            <div className="terminal-view__ctx-sep" />
            <button
              type="button"
              className="terminal-view__ctx-item"
              title={tr("term.find")}
              onClick={handleFind}
            >
              查找
            </button>
            <button
              type="button"
              className="terminal-view__ctx-item"
              title={tr("term.saveLog")}
              onClick={handleSaveLog}
            >
              保存日志
            </button>
            <button
              type="button"
              className="terminal-view__ctx-item"
              title={tr("term.clear")}
              onClick={handleClear}
            >
              清屏
            </button>
          </div>
        </div>
      )}
      {pastePending && (
        <div className="terminal-view__paste-confirm">
          <div className="terminal-view__paste-title">剪贴板包含多行内容</div>
          <pre className="terminal-view__paste-preview">{pastePending}</pre>
          <div className="terminal-view__paste-actions">
            <button type="button" className="ds-btn" title={tr("term.pasteCancel")} onClick={cancelPaste}>
              取消
            </button>
            <button
              type="button"
              className="ds-btn ds-btn--brand"
              title={tr("term.pasteMulti")}
              onClick={confirmPaste}
            >
              粘贴到终端
            </button>
          </div>
        </div>
      )}
      {tab.status === "error" && (
        <div className="terminal-view__error">
          <span className="terminal-view__error-icon">
            <Icon name="alert-circle" size={28} />
          </span>
          <div>连接失败</div>
          {tab.error && <div className="terminal-view__error-msg">{tab.error}</div>}
          <button className="ds-btn ds-btn--brand" type="button" title={tr("term.retry")} onClick={handleRetry}>
            重试
          </button>
        </div>
      )}
    </div>
  );
}
