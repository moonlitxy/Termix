import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
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
  const [retryKey, setRetryKey] = useState(0);

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
    terminal.open(container);
    termRef.current = terminal;
    fitRef.current = fitAddon;
    terminalRegistry.set(tab.id, terminal);
    terminalRegistry.clearBuffer(tab.id);

    try {
      fitAddon.fit();
    } catch {
      // 容器可能尚未布局，忽略
    }

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

    // 订阅连接状态
    onConnectionStatus((e) => {
      if (e.tabId === tab.id && e.status === "closed" && !cancelled) {
        updateTab(tab.id, { status: "disconnected" });
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
        updateTab(tab.id, { status: "error", error: String(e) });
        terminal.write("Error: " + String(e) + "\r\n");
      }
    };
    void connect();

    return () => {
      cancelled = true;
      dataDisp.dispose();
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

  return (
    <div className="terminal-view">
      <div className="terminal-view__container" ref={containerRef} />
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
