import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { Icon } from "./Icon";
import { useApp } from "../store/app";
import { ipc, onTerminalOutput, onConnectionStatus } from "../lib/ipc";
import { terminalRegistry } from "../lib/terminalRegistry";
import type { Tab } from "../types";

const TERMINAL_THEME = {
  background: "#1a1b1d",
  foreground: "#e0e3ee",
  cursor: "#d1d3db",
  cursorAccent: "#1a1b1d",
  selectionBackground: "rgba(56,123,255,0.3)",
  black: "#1a1b1d",
  red: "#f65a5a",
  green: "#33c192",
  yellow: "#ded47e",
  blue: "#387bff",
  magenta: "#b38cff",
  cyan: "#80bbff",
  white: "#d1d3db",
  brightBlack: "#666b75",
  brightRed: "#f86262",
  brightGreen: "#5ed4ad",
  brightYellow: "#dfb949",
  brightBlue: "#4c88ff",
  brightMagenta: "#f0d8ff",
  brightCyan: "#a6d9ff",
  brightWhite: "#f5f9fe",
};

export function TerminalView({ tab }: { tab: Tab }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const tabRef = useRef<Tab>(tab);
  const hasSelectionRef = useRef(false);
  const [retryKey, setRetryKey] = useState(0);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [pastePending, setPastePending] = useState<string | null>(null);

  const updateTab = useApp((s) => s.updateTab);

  // 始终保持 tabRef 指向最新的 tab
  tabRef.current = tab;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    const unlisteners: UnlistenFn[] = [];
    let ro: ResizeObserver | null = null;

    const terminal = new Terminal({
      fontFamily: "JetBrains Mono, SF Mono, Menlo, monospace",
      fontSize: 12,
      lineHeight: 1.5,
      cursorBlink: true,
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
    terminalRegistry.clearBuffer(tab.id);

    try {
      fitAddon.fit();
    } catch {
      // 容器可能尚未布局，忽略
    }
    // 进入终端视图时立即聚焦，恢复键盘输入（切换自 SFTP 等模块后无需手动点击）
    terminal.focus();

    // 订阅终端输出
    onTerminalOutput((e) => {
      if (e.tabId === tab.id && !cancelled) {
        terminal.write(e.data);
        terminalRegistry.append(tab.id, e.data);
      }
    }).then((un) => {
      if (cancelled) un();
      else unlisteners.push(un);
    });

    // 自动重连：意外断开后最多重试 3 次（主动断开不会触发）
    let reconnectCount = 0;
    let reconnecting = false;
    const doReconnect = async () => {
      if (cancelled || reconnecting) return;
      if (reconnectCount >= 3) {
        terminal.write("\r\n\x1b[31m自动重连失败，请手动重连\x1b[0m\r\n");
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
        });
        reconnectCount = 0;
        reconnecting = false;
        terminal.write("\x1b[32m重连成功\x1b[0m\r\n");
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

    // 用户输入回传后端
    const dataDisp = terminal.onData((data) => {
      const t = tabRef.current;
      if (t.connectionId && t.shellId) {
        ipc.terminalWrite(t.connectionId, t.shellId, data);
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
      try {
        fitAddon.fit();
        const t = tabRef.current;
        if (t.connectionId && t.shellId && terminal.cols > 0 && terminal.rows > 0) {
          ipc.terminalResize(t.connectionId, t.shellId, terminal.cols, terminal.rows);
        }
      } catch {
        // 忽略
      }
    });
    ro.observe(container);

    // 连接流程（仅未连接时）
    const connect = async () => {
      const current = tabRef.current;
      if (current.connectionId) return;
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
          const ok = window.confirm(
            `首次连接到 ${session.host}:${session.port}\n\n` +
              `主机密钥指纹：\n${fingerprint}\n\n` +
              `是否信任该密钥并继续连接？`
          );
          if (ok) {
            try {
              await ipc.hostKeyAccept(session.host, session.port, fingerprint);
              void connect();
            } catch (e2) {
              updateTab(tab.id, {
                status: "error",
                error: "保存主机密钥失败：" + String(e2),
              });
            }
            return;
          }
          updateTab(tab.id, {
            status: "error",
            error: "已取消连接（未信任主机密钥）",
          });
          return;
        }

        // 主机密钥变更：可能中间人攻击，需二次确认才允许覆盖信任
        const changed = msg.match(/^HOST_KEY_CHANGED:(.+):(.+)$/);
        if (changed && session) {
          updateTab(tab.id, { status: "error", error: "主机密钥变更，已阻止连接" });
          const warn = window.confirm(
            `警告：${session.host}:${session.port} 的主机密钥已变更！\n\n` +
              `当前指纹：${changed[1]}\n已信任指纹：${changed[2]}\n\n` +
              `这可能是中间人攻击，也可能是服务器已重装系统。\n` +
              `是否仍要继续连接？`
          );
          if (warn) {
            const sure = window.confirm(
              "再次确认：信任新的主机密钥并重新连接？"
            );
            if (sure) {
              try {
                await ipc.hostKeyAccept(session.host, session.port, changed[1]);
                void connect();
                return;
              } catch (e2) {
                updateTab(tab.id, { status: "error", error: String(e2) });
                return;
              }
            }
          }
          terminal.write(
            "主机密钥校验失败：密钥与之前信任的不一致，连接已拒绝。\r\n"
          );
          return;
        }

        updateTab(tab.id, { status: "error", error: String(e) });
        terminal.write("Error: " + String(e) + "\r\n");
      }
    };
    void connect();

    return () => {
      cancelled = true;
      dataDisp.dispose();
      container.removeEventListener("pointerdown", onContainerDown);
      container.removeEventListener("focusin", onContainerFocusIn);
      selDisp.dispose();
      unlisteners.forEach((un) => un());
      if (ro) ro.disconnect();
      // 仅销毁终端；连接断开由 EditorTabs/Toolbar 负责
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
  }, [tab.id, retryKey]);

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
    const menuH = 152;
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
          title="关闭分屏"
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
              disabled={!hasSelectionRef.current}
              onClick={handleCopy}
            >
              复制
            </button>
            <button type="button" className="terminal-view__ctx-item" onClick={handlePaste}>
              粘贴
            </button>
            <div className="terminal-view__ctx-sep" />
            <button type="button" className="terminal-view__ctx-item" onClick={handleFind}>
              查找
            </button>
            <button type="button" className="terminal-view__ctx-item" onClick={handleClear}>
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
            <button type="button" className="ds-btn" onClick={cancelPaste}>
              取消
            </button>
            <button
              type="button"
              className="ds-btn ds-btn--brand"
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
          <button className="ds-btn ds-btn--brand" type="button" onClick={handleRetry}>
            重试
          </button>
        </div>
      )}
    </div>
  );
}
