import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { useApp, selectFilteredSessions, nextTabId } from "../store/app";
import { ipc } from "../lib/ipc";
import type { Session } from "../types";

interface CtxMenu {
  x: number;
  y: number;
  session: Session;
}

export function SessionSidebar() {
  const sessions = useApp(selectFilteredSessions);
  const groups = useApp((s) => s.groups);
  const tabs = useApp((s) => s.tabs);
  const activity = useApp((s) => s.activity);
  const openNewConnection = useApp((s) => s.openNewConnection);
  const addTab = useApp((s) => s.addTab);
  const loadSessions = useApp((s) => s.loadSessions);
  const loadGroups = useApp((s) => s.loadGroups);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [groupsOpen, setGroupsOpen] = useState<Record<string, boolean>>({});
  const [ctx, setCtx] = useState<CtxMenu | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // 导出会话（JSON 备份下载）
  const handleExport = async () => {
    try {
      const json = await ipc.sessionsExport();
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const name = `termix-sessions-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json`;
      const blob = new Blob([json], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      window.alert("导出失败：" + String(e));
    }
  };

  // 导入会话（选择 JSON 备份）
  const handleImport = async (file: File) => {
    try {
      const content = await file.text();
      const res = await ipc.sessionsImport(content);
      void loadSessions();
      void loadGroups();
      window.alert(
        `导入完成：新增 ${res.sessionsCreated} 个会话、${res.groupsCreated} 个分组，跳过 ${res.sessionsSkipped} 个同名会话`
      );
    } catch (e) {
      window.alert("导入失败：" + String(e));
    }
  };

  const openSession = (session: Session) => {
    addTab({
      id: nextTabId(),
      kind: "terminal",
      sessionId: session.id,
      title: session.name,
      status: "connecting",
    });
  };

  const handleClick = (session: Session) => {
    setSelectedId(session.id);
    if (activity === "sftp") {
      const conn = tabs.find(
        (t) => t.sessionId === session.id && t.connectionId
      );
      if (conn?.connectionId) {
        useApp.getState().setSftpContext(session.id, conn.connectionId);
      } else {
        window.alert("该会话未连接，请先在终端中双击打开连接");
      }
    }
  };

  const handleDelete = async (session: Session) => {
    if (!window.confirm(`删除会话 ${session.name}？`)) return;
    try {
      await ipc.sessionDelete(session.id);
      void loadSessions();
    } catch (e) {
      window.alert(String(e));
    }
  };

  const handleCopyInfo = async (session: Session) => {
    try {
      await navigator.clipboard.writeText(
        `${session.username}@${session.host}:${session.port}`
      );
    } catch (e) {
      console.error("[session] copy failed:", e);
    }
  };

  useEffect(() => {
    if (!ctx) return;
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setCtx(null);
      }
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCtx(null);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [ctx]);

  const isOnline = (sessionId: string) =>
    tabs.some((t) => t.sessionId === sessionId && t.status === "connected");

  // 分组占位（store.groups 可能为空）
  const displayGroups =
    groups.length > 0
      ? groups
      : [
          { id: "g-prod", name: "生产环境", order: 0 },
          { id: "g-test", name: "测试环境", order: 1 },
        ];

  // 分组默认展开，折叠状态按分组独立记录
  const isGroupOpen = (id: string) => groupsOpen[id] !== false;

  const renderSessionRow = (s: Session, child = false) => {
    const online = isOnline(s.id);
    return (
      <div
        key={s.id}
        className={
          "session-row" +
          (child ? " session-row--child" : "") +
          (selectedId === s.id ? " is-active" : "")
        }
        onClick={() => handleClick(s)}
        onDoubleClick={() => openSession(s)}
        onContextMenu={(e) => {
          e.preventDefault();
          setSelectedId(s.id);
          setCtx({ x: e.clientX, y: e.clientY, session: s });
        }}
        title={s.host + ":" + s.port}
      >
        {!child && (
          <span className="session-row__chevron">
            <Icon name="chevron-down" size={12} />
          </span>
        )}
        <span
          className={
            "ds-dot " + (online ? "ds-dot--success-glow" : "ds-dot--muted")
          }
        />
        <span className="session-row__name">{s.name}</span>
        <span className="session-row__status">
          {online ? (
            <span className="ds-tag ds-tag--success">在线</span>
          ) : (
            <span className="ds-tag ds-tag--neutral">离线</span>
          )}
        </span>
      </div>
    );
  };

  return (
    <div className="session-sidebar">
      <div className="session-sidebar__header">
        <span>会话列表</span>
        <div className="session-sidebar__header-actions">
          <button
            className="ds-btn ds-btn--tertiary ds-btn--icon"
            type="button"
            title="导入会话（JSON）"
            onClick={() => fileRef.current?.click()}
          >
            <Icon name="upload" size={14} />
          </button>
          <button
            className="ds-btn ds-btn--tertiary ds-btn--icon"
            type="button"
            title="导出会话（JSON）"
            onClick={() => void handleExport()}
          >
            <Icon name="download" size={14} />
          </button>
          <button
            className="ds-btn ds-btn--tertiary ds-btn--icon"
            type="button"
            title="新建连接"
            onClick={() => openNewConnection()}
          >
            <Icon name="plus" size={14} />
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleImport(f);
            e.target.value = "";
          }}
        />
      </div>
      <div className="session-sidebar__body">
        <div className="session-sidebar__section-title">最近连接</div>
        {sessions.length === 0 ? (
          <div
            style={{
              padding: "8px 12px",
              color: "var(--text-tertiary)",
              fontSize: "var(--body-sm-font-size)",
            }}
          >
            暂无会话，点击 + 新建
          </div>
        ) : (
          sessions.map((s) => renderSessionRow(s))
        )}

        <div className="session-sidebar__section-title">分组</div>
        {displayGroups.map((g) => {
          const open = isGroupOpen(g.id);
          const groupSessions = sessions.filter((s) => s.groupId === g.id);
          return (
            <div key={g.id}>
              <div
                className="group-row"
                onClick={() =>
                  setGroupsOpen((m) => ({ ...m, [g.id]: !open }))
                }
                title={g.name}
              >
                <span className="session-row__chevron">
                  <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
                </span>
                <span style={{ color: "var(--text-tertiary)", display: "inline-flex" }}>
                  <Icon name="folder" size={14} />
                </span>
                <span className="group-row__name">{g.name}</span>
                <span className="ds-tag ds-tag--count">{groupSessions.length}</span>
              </div>
              {open && groupSessions.map((s) => renderSessionRow(s, true))}
            </div>
          );
        })}
      </div>

      {ctx && (
        <div
          className="ctx-menu"
          ref={menuRef}
          style={{ left: ctx.x, top: ctx.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="ctx-menu__item"
            onClick={() => {
              openSession(ctx.session);
              setCtx(null);
            }}
          >
            <Icon name="terminal" size={12} />
            在新标签连接
          </button>
          <button
            type="button"
            className="ctx-menu__item"
            onClick={() => {
              openNewConnection(ctx.session);
              setCtx(null);
            }}
          >
            <Icon name="edit" size={12} />
            编辑连接
          </button>
          <button
            type="button"
            className="ctx-menu__item"
            onClick={() => {
              void handleCopyInfo(ctx.session);
              setCtx(null);
            }}
          >
            <Icon name="copy" size={12} />
            复制连接信息
          </button>
          <button
            type="button"
            className="ctx-menu__item ctx-menu__item--danger"
            onClick={() => {
              void handleDelete(ctx.session);
              setCtx(null);
            }}
          >
            <Icon name="trash" size={12} />
            删除
          </button>
        </div>
      )}
    </div>
  );
}
