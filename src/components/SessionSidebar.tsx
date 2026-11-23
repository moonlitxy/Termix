import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { useApp, selectFilteredSessions, nextTabId } from "../store/app";
import { ipc } from "../lib/ipc";
import { useClampedMenuPosition } from "../lib/contextMenu";
import { useT } from "../lib/i18n";
import { confirmDialog, toast } from "../store/feedback";
import { SidebarStats } from "./SidebarStats";
import type { Group, Session } from "../types";

interface CtxMenu {
  x: number;
  y: number;
  session: Session;
}

interface GroupCtxMenu {
  x: number;
  y: number;
  group: Group;
}

export function SessionSidebar() {
  const t = useT();
  const sessions = useApp(selectFilteredSessions);
  const groups = useApp((s) => s.groups);
  const tabs = useApp((s) => s.tabs);
  const openNewConnection = useApp((s) => s.openNewConnection);
  const addTab = useApp((s) => s.addTab);
  const loadSessions = useApp((s) => s.loadSessions);
  const loadGroups = useApp((s) => s.loadGroups);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [groupsOpen, setGroupsOpen] = useState<Record<string, boolean>>({});
  const [ctx, setCtx] = useState<CtxMenu | null>(null);
  const [groupCtx, setGroupCtx] = useState<GroupCtxMenu | null>(null);
  const [addingGroup, setAddingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [draggingSessionId, setDraggingSessionId] = useState<string | null>(null);
  const [dragOverGroupId, setDragOverGroupId] = useState<string | null>(null);
  const [dragOverUngrouped, setDragOverUngrouped] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const sshFileRef = useRef<HTMLInputElement>(null);
  // 导入入口菜单：JSON 备份 / SSH Config 文件 / ~/.ssh/config
  const [importMenu, setImportMenu] = useState<{ x: number; y: number } | null>(null);
  const importMenuRef = useRef<HTMLDivElement>(null);
  const importMenuPos = useClampedMenuPosition(importMenu, importMenuRef);

  // 导入菜单：点击外部 / Esc 关闭
  useEffect(() => {
    if (!importMenu) return;
    const onDocClick = (e: MouseEvent) => {
      if (importMenuRef.current && !importMenuRef.current.contains(e.target as Node)) {
        setImportMenu(null);
      }
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setImportMenu(null);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [importMenu]);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuReturnRef = useRef<HTMLElement | null>(null);
  const menuPosition = useClampedMenuPosition(ctx ?? groupCtx, menuRef);
  const draggingSession = sessions.find((s) => s.id === draggingSessionId);

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
      toast.success(t("session.exported"));
    } catch (e) {
      toast.error(t("session.exportFailed", { e: String(e) }));
    }
  };

  // 导入会话（选择 JSON 备份）
  const handleImport = async (file: File) => {
    try {
      const content = await file.text();
      const res = await ipc.sessionsImport(content);
      void loadSessions();
      void loadGroups();
      const msg =
        res.secretsCleared > 0
          ? t("session.importDoneSecrets", { c: res.sessionsCreated, g: res.groupsCreated, s: res.sessionsSkipped, n: res.secretsCleared })
          : t("session.importDoneMsg", { c: res.sessionsCreated, g: res.groupsCreated, s: res.sessionsSkipped });
      if (res.secretsCleared > 0) toast.warning(msg, t("session.importDone"));
      else toast.success(msg, t("session.importDone"));
    } catch (e) {
      toast.error(t("session.importFailed", { e: String(e) }));
    }
  };

  // 导入 SSH Config（文件内容走同一套去重/加密规则）
  const handleSshConfigImport = async (content: string, source: string) => {
    try {
      const res = await ipc.sshConfigImport(content);
      void loadSessions();
      void loadGroups();
      toast.success(
        t("session.sshImportDone", { src: source, c: res.sessionsCreated, s: res.sessionsSkipped }),
        t("session.importDone")
      );
    } catch (e) {
      toast.error(t("session.sshImportFailed", { e: String(e) }));
    }
  };

  // 一键读取本机 ~/.ssh/config 并导入
  const handleSshConfigDefault = async () => {
    setImportMenu(null);
    try {
      const content = await ipc.sshConfigReadDefault();
      await handleSshConfigImport(content, "~/.ssh/config");
    } catch (e) {
      toast.error(String(e));
    }
  };

  const openSession = (session: Session) => {
    setSelectedId(session.id);
    useApp.setState({ activity: "terminal" });
    addTab({
      id: nextTabId(),
      kind: "terminal",
      sessionId: session.id,
      title: session.name,
      status: "connecting",
    });
  };

  // 会话行与右键菜单能力对齐：Enter/Space 选中，Enter 连接，Shift+F10 / Menu 打开菜单
  const openSessionMenu = (
    session: Session,
    position: { x: number; y: number }
  ) => {
    menuReturnRef.current = document.activeElement as HTMLElement | null;
    setSelectedId(session.id);
    setCtx({ ...position, session });
  };

  const handleClick = (session: Session) => {
    setSelectedId(session.id);
  };

  const handleDelete = async (session: Session) => {
    const confirmed = await confirmDialog({
      title: t("session.deleteTitle"),
      message: t("session.deleteMsg", { n: session.name }),
      confirmText: t("common.delete"),
      danger: true,
    });
    if (!confirmed) return;
    try {
      await ipc.sessionDelete(session.id);
      void loadSessions();
      toast.success(t("session.deleted", { n: session.name }));
    } catch (e) {
      toast.error(String(e));
    }
  };

  const handleCopyInfo = async (session: Session) => {
    try {
      await navigator.clipboard.writeText(
        `${session.username}@${session.host}:${session.port}`
      );
      toast.success(t("session.copied"));
    } catch (e) {
      console.error("[session] copy failed:", e);
      toast.error(t("session.copyFailed"));
    }
  };

  const moveSessionToGroup = async (sessionId: string, groupId: string | null) => {
    const session = sessions.find((s) => s.id === sessionId);
    if (!session || (session.groupId ?? "") === (groupId ?? "")) return;
    try {
      await ipc.sessionMove(sessionId, groupId);
      await loadSessions();
      if (groupId) setGroupsOpen((m) => ({ ...m, [groupId]: true }));
      const groupName = groupId
        ? (groups.find((g) => g.id === groupId)?.name ?? t("session.groupFallback"))
        : t("session.ungrouped");
      toast.success(t("session.moved", { n: session.name, g: groupName }));
    } catch (e) {
      toast.error(t("session.moveFailed", { e: String(e) }));
    }
  };

  const startSessionDrag = (e: React.DragEvent, session: Session) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", session.id);
    setDraggingSessionId(session.id);
  };

  const endSessionDrag = () => {
    setDraggingSessionId(null);
    setDragOverGroupId(null);
    setDragOverUngrouped(false);
  };

  const handleGroupDragOver = (e: React.DragEvent, group: Group) => {
    if (!draggingSessionId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverUngrouped(false);
    if (dragOverGroupId !== group.id) setDragOverGroupId(group.id);
  };

  const handleGroupDragLeave = (e: React.DragEvent, group: Group) => {
    const next = e.relatedTarget as Node | null;
    if (next && e.currentTarget.contains(next)) return;
    setDragOverGroupId((current) => (current === group.id ? null : current));
  };

  const handleGroupDrop = async (e: React.DragEvent, group: Group) => {
    if (!draggingSessionId) return;
    e.preventDefault();
    e.stopPropagation();
    const sessionId =
      e.dataTransfer.getData("text/plain") || draggingSessionId;
    endSessionDrag();
    if (sessionId) await moveSessionToGroup(sessionId, group.id);
  };

  const handleUngroupedDragOver = (e: React.DragEvent) => {
    if (!draggingSessionId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverGroupId(null);
    setDragOverUngrouped(true);
  };

  const handleUngroupedDragLeave = (e: React.DragEvent) => {
    const next = e.relatedTarget as Node | null;
    if (next && e.currentTarget.contains(next)) return;
    setDragOverUngrouped(false);
  };

  const handleUngroupedDrop = async (e: React.DragEvent) => {
    if (!draggingSessionId) return;
    e.preventDefault();
    const sessionId =
      e.dataTransfer.getData("text/plain") || draggingSessionId;
    endSessionDrag();
    if (sessionId) await moveSessionToGroup(sessionId, null);
  };

  useEffect(() => {
    if (!ctx && !groupCtx) return;
    const frame = window.requestAnimationFrame(() => {
      menuRef.current
        ?.querySelector<HTMLElement>("button:not([disabled])")
        ?.focus();
    });
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setCtx(null);
        setGroupCtx(null);
      }
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setCtx(null);
        setGroupCtx(null);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
      menuReturnRef.current?.focus();
      menuReturnRef.current = null;
    };
  }, [ctx, groupCtx]);

  const sessionState = (sessionId: string) => {
    const matches = tabs.filter((t) => t.sessionId === sessionId);
    if (matches.some((t) => t.status === "connected")) {
      return { key: "online", text: t("session.online"), dot: "ds-dot--success-glow" };
    }
    if (matches.some((t) => t.status === "connecting")) {
      return { key: "connecting", text: t("session.connecting"), dot: "ds-dot--warning" };
    }
    if (matches.some((t) => t.status === "error")) {
      return { key: "error", text: t("session.error"), dot: "ds-dot--error" };
    }
    return { key: "offline", text: t("session.offline"), dot: "ds-dot--muted" };
  };

  // ---- 分组管理 ----
  const submitGroup = async () => {
    const name = newGroupName.trim();
    if (!name) return;
    try {
      await ipc.groupCreate({ name });
      await loadGroups();
      setAddingGroup(false);
      setNewGroupName("");
    } catch (e) {
      toast.error(t("session.newGroupFailed", { e: String(e) }));
    }
  };

  const handleDeleteGroup = async (g: Group) => {
    const confirmed = await confirmDialog({
      title: t("session.deleteGroupTitle"),
      message: t("session.deleteGroupMsg", { n: g.name }),
      confirmText: t("common.delete"),
      danger: true,
    });
    if (!confirmed) return;
    try {
      await ipc.groupDelete(g.id);
      await loadGroups();
      toast.success(t("session.groupDeleted", { n: g.name }));
    } catch (e) {
      toast.error(String(e));
    }
  };

  // 分组默认展开，折叠状态按分组独立记录
  const isGroupOpen = (id: string) => groupsOpen[id] !== false;

  const renderSessionRow = (s: Session, child = false) => {
    const state = sessionState(s.id);
    return (
      <div
        key={s.id}
        className={
          "session-row" +
          (child ? " session-row--child" : "") +
          (selectedId === s.id ? " is-active" : "") +
          (draggingSessionId === s.id ? " is-dragging" : "")
        }
        draggable
        onDragStart={(e) => startSessionDrag(e, s)}
        onDragEnd={endSessionDrag}
        onClick={() => handleClick(s)}
        role="button"
        tabIndex={0}
        aria-current={selectedId === s.id ? "true" : undefined}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleClick(s);
            if (e.key === "Enter") openSession(s);
          } else if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") {
            e.preventDefault();
            const rect = e.currentTarget.getBoundingClientRect();
            openSessionMenu(s, { x: rect.right, y: rect.bottom });
          }
        }}
        onDoubleClick={() => openSession(s)}
        onContextMenu={(e) => {
          e.preventDefault();
          openSessionMenu(s, { x: e.clientX, y: e.clientY });
        }}
      >
        <span
          className={"ds-dot " + state.dot}
        />
        <span className="session-row__label">
          <span className="session-row__name-row">
            <span className="session-row__name">{s.name}</span>
            {s.jumpSessionId && <span className="session-row__jump" title={t("session.viaJumpTitle")}>{t("session.viaJump")}</span>}
            {s.agentForward && <span className="session-row__jump" title={t("session.agentFwdTitle")}>{t("session.agentFwd")}</span>}
          </span>
        </span>
        <span className={"session-row__state session-row__state--" + state.key}>
          {state.text}
        </span>
      </div>
    );
  };

  return (
    <div className="session-sidebar">
      <SidebarStats />
      <div className="session-sidebar__header">
        <span className="session-sidebar__heading">
          {t("session.sessions")}
          <span className="session-sidebar__count">{sessions.length}</span>
        </span>
        <div className="session-sidebar__header-actions">
          <button
            className="ds-btn ds-btn--tertiary ds-btn--icon"
            type="button"
            title={t("session.importMenu")}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setImportMenu({ x: rect.left, y: rect.bottom + 4 });
            }}
          >
            <Icon name="upload" size={14} />
          </button>
          <button
            className="ds-btn ds-btn--tertiary ds-btn--icon"
            type="button"
            title={t("session.exportTitle")}
            onClick={() => void handleExport()}
          >
            <Icon name="download" size={14} />
          </button>
          <button
            className="ds-btn ds-btn--tertiary ds-btn--icon"
            type="button"
            title={t("session.newConnTitle")}
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
        <input
          ref={sshFileRef}
          type="file"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void f.text().then((t) => handleSshConfigImport(t, f.name));
            e.target.value = "";
          }}
        />
      </div>
      <div className="session-sidebar__body">
        <div className="session-sidebar__section-title">{t("session.recent")}</div>
        {sessions.length === 0 ? (
          <div className="session-sidebar__empty">{t("session.empty")}</div>
        ) : (
          sessions.map((s) => renderSessionRow(s))
        )}

        <div className="session-sidebar__section-head">
          <span className="session-sidebar__section-title">{t("session.groups")}</span>
          <button
            className="ds-btn ds-btn--tertiary ds-btn--icon"
            type="button"
            title={t("session.newGroup")}
            onClick={() => {
              setAddingGroup(true);
              setNewGroupName("");
            }}
          >
            <Icon name="plus" size={13} />
          </button>
        </div>
        {addingGroup && (
          <div className="group-add">
            <input
              className="ds-input group-add__input"
              type="text"
              value={newGroupName}
              placeholder={t("session.groupNamePh")}
              autoFocus
              onChange={(e) => setNewGroupName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submitGroup();
                if (e.key === "Escape") setAddingGroup(false);
              }}
            />
            <div className="group-add__actions">
              <button
                className="ds-btn ds-btn--brand ds-btn--sm"
                type="button"
                title={t("session.createGroupTitle")}
                onClick={() => void submitGroup()}
                disabled={!newGroupName.trim()}
              >{t("feedback.ok")}</button>
              <button
                className="ds-btn ds-btn--tertiary ds-btn--sm"
                type="button"
                title={t("session.cancelCreateGroupTitle")}
                onClick={() => setAddingGroup(false)}
              >{t("common.cancel")}</button>
            </div>
          </div>
        )}
        {groups.length === 0 ? (
          <div className="session-sidebar__empty-hint">{t("session.noGroups")}</div>
        ) : (
          groups.map((g) => {
            const open = isGroupOpen(g.id);
            const groupSessions = sessions.filter((s) => s.groupId === g.id);
            return (
              <div key={g.id}>
                <div
                  className={
                    "group-row" +
                    (dragOverGroupId === g.id ? " is-drop-target" : "")
                  }
                  onClick={() =>
                    setGroupsOpen((m) => ({ ...m, [g.id]: !open }))
                  }
                  onDragOver={(e) => handleGroupDragOver(e, g)}
                  onDragLeave={(e) => handleGroupDragLeave(e, g)}
                  onDrop={(e) => void handleGroupDrop(e, g)}
                  role="button"
                  tabIndex={0}
                  aria-expanded={open}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.preventDefault();
                    setGroupsOpen((m) => ({ ...m, [g.id]: !open }));
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setGroupCtx({ x: e.clientX, y: e.clientY, group: g });
                  }}
                >
                  <span className="session-row__chevron">
                    <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
                  </span>
                  <span style={{ color: "var(--text-tertiary)", display: "inline-flex" }}>
                    <Icon name="folder" size={14} />
                  </span>
                  <span className="group-row__name">{g.name}</span>
                  <span className="ds-tag ds-tag--count">{groupSessions.length}</span>
                  <button
                    className="group-row__add"
                    type="button"
                    title={t("session.newConnInGroup", { n: g.name })}
                    onClick={(e) => {
                      e.stopPropagation();
                      openNewConnection(undefined, g.id);
                    }}
                  >
                    <Icon name="plus" size={12} />
                  </button>
                </div>
                {open && groupSessions.map((s) => renderSessionRow(s, true))}
              </div>
            );
          })
        )}
        {draggingSession?.groupId && (
          <div
            className={
              "session-drop-ungrouped" +
              (dragOverUngrouped ? " is-drop-target" : "")
            }
            onDragOver={handleUngroupedDragOver}
            onDragLeave={handleUngroupedDragLeave}
            onDrop={(e) => void handleUngroupedDrop(e)}
          >
            <Icon name="folder" size={13} />{t("session.moveUngrouped")}</div>
        )}
      </div>

      {importMenu && (
        <div
          className="ctx-menu"
          ref={importMenuRef}
          style={{ left: importMenuPos?.x ?? importMenu.x, top: importMenuPos?.y ?? importMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="ctx-menu__item"
            title={t("session.importJsonTitle")}
            onClick={() => {
              setImportMenu(null);
              fileRef.current?.click();
            }}
          >
            <Icon name="upload" size={12} />{t("session.importJson")}</button>
          <button
            type="button"
            className="ctx-menu__item"
            title={t("session.importSshFileTitle")}
            onClick={() => {
              setImportMenu(null);
              sshFileRef.current?.click();
            }}
          >
            <Icon name="terminal" size={12} />{t("session.importSshFile")}</button>
          <button
            type="button"
            className="ctx-menu__item"
            title={t("session.importSshDefaultTitle")}
            onClick={() => void handleSshConfigDefault()}
          >
            <Icon name="folder" size={12} />{t("session.importSshDefault")}</button>
        </div>
      )}

      {ctx && (
        <div
          className="ctx-menu"
          ref={menuRef}
          style={{ left: menuPosition?.x ?? ctx.x, top: menuPosition?.y ?? ctx.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="ctx-menu__item"
            title={t("session.openTab")}
            onClick={() => {
              openSession(ctx.session);
              setCtx(null);
            }}
          >
            <Icon name="terminal" size={12} />{t("session.openTabShort")}</button>
          <button
            type="button"
            className="ctx-menu__item"
            title={t("session.editConnTitle")}
            onClick={() => {
              openNewConnection(ctx.session);
              setCtx(null);
            }}
          >
            <Icon name="edit" size={12} />{t("session.editConn")}</button>
          <button
            type="button"
            className="ctx-menu__item"
            title={t("session.copyConnTitle")}
            onClick={() => {
              void handleCopyInfo(ctx.session);
              setCtx(null);
            }}
          >
            <Icon name="copy" size={12} />{t("session.copyConn")}</button>
          <button
            type="button"
            className="ctx-menu__item ctx-menu__item--danger"
            title={t("session.deleteTitle")}
            onClick={() => {
              void handleDelete(ctx.session);
              setCtx(null);
            }}
          >
            <Icon name="trash" size={12} />{t("common.delete")}</button>
        </div>
      )}

      {groupCtx && (
        <div
          className="ctx-menu"
          ref={menuRef}
          style={{
            left: menuPosition?.x ?? groupCtx.x,
            top: menuPosition?.y ?? groupCtx.y,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="ctx-menu__item"
            title={t("session.newGroupConnTitle")}
            onClick={() => {
              openNewConnection(undefined, groupCtx.group.id);
              setGroupCtx(null);
            }}
          >
            <Icon name="plus" size={12} />{t("session.newGroupConn")}</button>
          <div className="ctx-menu__sep" />
          <button
            type="button"
            className="ctx-menu__item ctx-menu__item--danger"
            title={t("session.deleteGroupTitle")}
            onClick={() => {
              void handleDeleteGroup(groupCtx.group);
              setGroupCtx(null);
            }}
          >
            <Icon name="trash" size={12} />{t("session.deleteGroup")}</button>
        </div>
      )}
    </div>
  );
}
