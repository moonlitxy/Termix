import { Fragment, useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { useApp, joinPath } from "../store/app";
import { ipc, onTransferProgress } from "../lib/ipc";
import { sftpContextMenu, type SftpMenuItem } from "../lib/sftpMenu";
import type { SftpItem } from "../types";

function formatSize(n: number): string {
  if (!n) return "-";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

function formatMtime(ts: number): string {
  if (!ts) return "-";
  const d = new Date(ts * 1000);
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface PaneProps {
  title: string;
  side: "remote" | "local";
  path: string;
  items: SftpItem[];
  selected: SftpItem | null;
  dropHover: boolean;
  onSelect: (item: SftpItem | null) => void;
  onOpen: (item: SftpItem) => void;
  onUp: () => void;
  onPathChange: (p: string) => void;
  onPathSubmit: () => void;
  onTargetHover: (side: "remote" | "local" | null) => void;
  onPaneDrop: (e: React.DragEvent) => void;
  onRowContextMenu: (e: React.MouseEvent, item: SftpItem) => void;
  onBlankContextMenu: (e: React.MouseEvent) => void;
}

function FsPane({
  title,
  side,
  path,
  items,
  selected,
  dropHover,
  onSelect,
  onOpen,
  onUp,
  onPathChange,
  onPathSubmit,
  onTargetHover,
  onPaneDrop,
  onRowContextMenu,
  onBlankContextMenu,
}: PaneProps) {
  return (
    <div
      className={"sftp-pane" + (dropHover ? " is-drop-target" : "")}
      onDragOver={(e) => {
        e.preventDefault();
        onTargetHover(side);
      }}
      onDragLeave={() => onTargetHover(null)}
      onDrop={(e) => {
        e.preventDefault();
        onTargetHover(null);
        onPaneDrop(e);
      }}
    >
      <div className="sftp-pane__title">{title}</div>
      <div className="sftp-pathbar">
        <button
          className="ds-btn ds-btn--tertiary ds-btn--sm"
          type="button"
          title="上级目录"
          onClick={onUp}
        >
          <Icon name="arrow-up" size={12} />
        </button>
        <input
          className="sftp-pathbar__input"
          value={path}
          onChange={(e) => onPathChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onPathSubmit()}
          spellCheck={false}
        />
      </div>
      <div
        className="sftp-list"
        onContextMenu={(e) => {
          e.preventDefault();
          onBlankContextMenu(e);
        }}
      >
        {items.map((it) => (
          <div
            key={it.path}
            className={
              "sftp-row" + (selected?.path === it.path ? " is-active" : "")
            }
            draggable={!it.isDir}
            onDragStart={(e) => {
              if (it.isDir) return;
              e.dataTransfer.setData(
                side === "remote" ? "termix-remote" : "termix-local",
                it.path
              );
              e.dataTransfer.effectAllowed = "copy";
            }}
            onClick={() => onSelect(it)}
            onDoubleClick={() => onOpen(it)}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onRowContextMenu(e, it);
            }}
            title={it.path}
          >
            <span className="sftp-row__icon">
              <Icon name={it.isDir ? "folder" : "file"} size={13} />
            </span>
            <span className="sftp-row__name">{it.name}</span>
            <span className="sftp-row__meta">
              {it.isDir ? "目录" : formatSize(it.size)}
            </span>
            <span className="sftp-row__mtime">{formatMtime(it.mtime)}</span>
          </div>
        ))}
        {items.length === 0 && <div className="sftp-empty">空目录</div>}
        <div className="sftp-pane__hint">
          {side === "remote"
            ? "可拖拽本地文件到此处上传"
            : "可拖拽远程文件到此处下载"}
        </div>
      </div>
    </div>
  );
}

export function SftpView() {
  const sftpContext = useApp((s) => s.sftpContext);
  const remotePath = useApp((s) => s.remotePath);
  const localPath = useApp((s) => s.localPath);
  const remoteItems = useApp((s) => s.remoteItems);
  const localItems = useApp((s) => s.localItems);
  const remoteSelected = useApp((s) => s.remoteSelected);
  const localSelected = useApp((s) => s.localSelected);
  const sessions = useApp((s) => s.sessions);
  const tabs = useApp((s) => s.tabs);

  const [remoteDraft, setRemoteDraft] = useState(remotePath);
  const [localDraft, setLocalDraft] = useState(localPath);
  const [dropHover, setDropHover] = useState<"remote" | "local" | null>(null);
  const hoverRef = useRef<"remote" | "local" | null>(null);
  const [ctx, setCtx] = useState<{
    x: number;
    y: number;
    side: "remote" | "local";
    item: SftpItem | null;
  } | null>(null);
  const ctxRef = useRef<HTMLDivElement>(null);
  const sessionName = sftpContext
    ? sessions.find((s) => s.id === sftpContext.sessionId)?.name ?? "已连接会话"
    : null;

  // 右键菜单：点击外部 / Esc 关闭
  useEffect(() => {
    if (!ctx) return;
    const onDocClick = (e: MouseEvent) => {
      if (ctxRef.current && !ctxRef.current.contains(e.target as Node)) {
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

  const copyPath = async (p: string) => {
    try {
      await navigator.clipboard.writeText(p);
    } catch (e) {
      console.error("[sftp] copy path failed:", e);
    }
  };

  // 右键菜单项分发
  const runMenuAction = (m: SftpMenuItem) => {
    if (!ctx) return;
    const item = ctx.item;
    switch (m.id) {
      case "download":
        if (item) void (item.isDir ? doDownloadDir(item) : doDownload(item));
        break;
      case "upload":
        if (item) void (item.isDir ? doUploadDir(item) : doUpload(item));
        break;
      case "rename":
        if (item) void handleRename(item);
        break;
      case "delete":
        if (item) void handleDelete(item);
        break;
      case "copyPath":
        if (item) void copyPath(item.path);
        break;
      case "mkdir":
        void handleMkdir();
        break;
      case "refresh":
        handleRefresh();
        break;
    }
    setCtx(null);
  };

  useEffect(() => {
    setRemoteDraft(remotePath);
  }, [remotePath]);
  useEffect(() => {
    setLocalDraft(localPath);
  }, [localPath]);

  // 上传/下载任务完成后刷新对应目录
  useEffect(() => {
    let un: (() => void) | undefined;
    onTransferProgress((e) => {
      if (e.status === "completed") {
        if (e.direction === "upload") {
          void useApp.getState().loadRemote();
        } else if (e.direction === "download") {
          void useApp.getState().loadLocal();
        }
      }
    })
      .then((u) => {
        un = u;
      })
      .catch(() => {
        /* browser mode */
      });
    return () => {
      un?.();
    };
  }, []);

  // 系统文件拖入（Tauri webview 事件）：拖到远程栏视为上传
  useEffect(() => {
    if (!("__TAURI__" in window)) return;
    let un: (() => void) | undefined;
    import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((ev) => {
          const p = ev.payload;
          if (p.type !== "drop" || !p.paths?.length) return;
          const target = hoverRef.current;
          console.log("[sftp] system files dropped:", p.paths, "target:", target);
          const st = useApp.getState();
          if (!st.sftpContext) {
            window.alert("请先在左侧选择一个已连接的会话，再拖拽文件上传");
            return;
          }
          if (target !== "remote") {
            window.alert("请将文件拖到左侧「远程」栏上传");
            return;
          }
          const failures: string[] = [];
          const ctx = st.sftpContext;
          const uploads = p.paths.map((path) => {
            const name = path.split(/[\\/]/).pop() || path;
            const dest = joinPath(st.remotePath, name);
            return ipc
              .sftpUpload(ctx.connectionId, ctx.sessionId, path, dest)
              .then((tid) => console.log("[sftp] system upload task started:", tid))
              .catch((e) => {
                console.error("[sftp] system upload failed:", path, e);
                failures.push(`${name}: ${String(e)}`);
              });
          });
          void Promise.all(uploads).then(() => {
            if (failures.length > 0) {
              window.alert(`有 ${failures.length} 个文件上传失败：\n${failures.join("\n")}`);
            }
          });
        })
      )
      .then((u) => {
        un = u;
      })
      .catch((e) => console.warn("[sftp] drag-drop listener unavailable:", e));
    return () => {
      un?.();
    };
  }, []);

  const setHover = (side: "remote" | "local" | null) => {
    hoverRef.current = side;
    setDropHover(side);
  };

  // 应用内拖拽：本地行拖到远程栏=上传，远程行拖到本地栏=下载
  const handlePaneDrop = (side: "remote" | "local") => (e: React.DragEvent) => {
    const dt = e.dataTransfer;
    const remotePathData = dt.getData("termix-remote");
    const localPathData = dt.getData("termix-local");
    if (side === "remote" && localPathData) {
      const name = localPathData.split("/").pop() || localPathData;
      void doUpload({ name, path: localPathData, isDir: false, size: 0, mtime: 0 });
    } else if (side === "local" && remotePathData) {
      const name = remotePathData.split("/").pop() || remotePathData;
      void doDownload({ name, path: remotePathData, isDir: false, size: 0, mtime: 0 });
    }
  };

  const doUpload = async (local: SftpItem) => {
    const st = useApp.getState();
    if (!st.sftpContext) {
      window.alert("请先在左侧选择一个已连接的会话，再上传文件");
      return;
    }
    const dest = joinPath(st.remotePath, local.name);
    console.log("[sftp] upload", { local: local.path, remote: dest, conn: st.sftpContext.connectionId });
    try {
      const taskId = await ipc.sftpUpload(
        st.sftpContext.connectionId,
        st.sftpContext.sessionId,
        local.path,
        dest
      );
      console.log("[sftp] upload task started:", taskId);
    } catch (e) {
      console.error("[sftp] upload failed:", e);
      window.alert(`上传 ${local.name} 失败：${String(e)}`);
    }
  };

  const doDownload = async (remote: SftpItem) => {
    const st = useApp.getState();
    if (!st.sftpContext) {
      window.alert("请先在左侧选择一个已连接的会话，再下载文件");
      return;
    }
    const dest = joinPath(st.localPath, remote.name);
    console.log("[sftp] download", { remote: remote.path, local: dest, conn: st.sftpContext.connectionId });
    try {
      const taskId = await ipc.sftpDownload(
        st.sftpContext.connectionId,
        st.sftpContext.sessionId,
        remote.path,
        dest
      );
      console.log("[sftp] download task started:", taskId);
    } catch (e) {
      console.error("[sftp] download failed:", e);
      window.alert(`下载 ${remote.name} 失败：${String(e)}`);
    }
  };

  const doUploadDir = async (local: SftpItem) => {
    const st = useApp.getState();
    if (!st.sftpContext) {
      window.alert("请先在左侧选择一个已连接的会话，再上传目录");
      return;
    }
    const dest = joinPath(st.remotePath, local.name);
    console.log("[sftp] upload-dir", { local: local.path, remote: dest, conn: st.sftpContext.connectionId });
    try {
      const taskId = await ipc.sftpUploadDir(
        st.sftpContext.connectionId,
        st.sftpContext.sessionId,
        local.path,
        dest
      );
      console.log("[sftp] upload-dir task started:", taskId);
    } catch (e) {
      console.error("[sftp] upload-dir failed:", e);
      window.alert(`上传目录 ${local.name} 失败：${String(e)}`);
    }
  };

  const doDownloadDir = async (remote: SftpItem) => {
    const st = useApp.getState();
    if (!st.sftpContext) {
      window.alert("请先在左侧选择一个已连接的会话，再下载目录");
      return;
    }
    const dest = joinPath(st.localPath, remote.name);
    console.log("[sftp] download-dir", { remote: remote.path, local: dest, conn: st.sftpContext.connectionId });
    try {
      const taskId = await ipc.sftpDownloadDir(
        st.sftpContext.connectionId,
        st.sftpContext.sessionId,
        remote.path,
        dest
      );
      console.log("[sftp] download-dir task started:", taskId);
    } catch (e) {
      console.error("[sftp] download-dir failed:", e);
      window.alert(`下载目录 ${remote.name} 失败：${String(e)}`);
    }
  };

  const handleOpen = (side: "remote" | "local", item: SftpItem) => {
    const st = useApp.getState();
    if (item.isDir) {
      void (side === "remote"
        ? st.openRemoteDir(item)
        : st.openLocalDir(item));
    } else if (side === "remote") {
      void doDownload(item);
    } else {
      void doUpload(item);
    }
  };

  const handleRefresh = () => {
    void useApp.getState().loadRemote();
    void useApp.getState().loadLocal();
  };

  const handleMkdir = async () => {
    if (!sftpContext) return;
    const name = window.prompt("新建文件夹名称");
    if (!name) return;
    try {
      await ipc.sftpMkdir(sftpContext.connectionId, joinPath(remotePath, name));
      void useApp.getState().loadRemote();
    } catch (e) {
      window.alert(String(e));
    }
  };

  const handleDelete = async (item: SftpItem) => {
    if (!sftpContext) return;
    if (!window.confirm(`删除 ${item.name}？`)) return;
    try {
      await ipc.sftpRemove(sftpContext.connectionId, item.path, item.isDir);
      void useApp.getState().loadRemote();
    } catch (e) {
      window.alert(String(e));
    }
  };

  const handleRename = async (item: SftpItem) => {
    if (!sftpContext) return;
    const name = window.prompt("新名称", item.name);
    if (!name || name === item.name) return;
    const newPath = joinPath(item.path.replace(/\/[^/]+$/, ""), name);
    try {
      await ipc.sftpRename(sftpContext.connectionId, item.path, newPath);
      void useApp.getState().loadRemote();
    } catch (e) {
      window.alert(String(e));
    }
  };

  if (!sftpContext) {
    return (
      <div className="workspace__empty">
        <span className="workspace__empty-logo">
          <Icon name="folder" size={56} />
        </span>
        <div className="workspace__empty-text">
          请先在左侧选择一个已连接的会话，再进入 SFTP
        </div>
        <div className="workspace__empty-sub">
          {tabs.filter((t) => t.connectionId).length > 0
            ? "点击左侧会话列表中的已连接会话即可"
            : "双击会话在终端中连接后，单击会话行选择"}
        </div>
      </div>
    );
  }

  return (
    <div className="sftp-view">
      <div className="sftp-toolbar">
        <span className="sftp-toolbar__session">
          <Icon name="folder" size={13} />
          {sessionName ?? "SFTP"}
          <span className="sftp-toolbar__path">{remotePath}</span>
        </span>
        <div className="sftp-toolbar__actions">
          <button
            className="ds-btn ds-btn--secondary ds-btn--sm"
            type="button"
            onClick={handleRefresh}
          >
            <Icon name="refresh" size={12} />刷新
          </button>
          <button
            className="ds-btn ds-btn--secondary ds-btn--sm"
            type="button"
            onClick={() => void handleMkdir()}
          >
            <Icon name="plus" size={12} />新建文件夹
          </button>
          {remoteSelected && (
            <button
              className="ds-btn ds-btn--secondary ds-btn--sm"
              type="button"
              onClick={() => void handleRename(remoteSelected)}
            >
              <Icon name="edit" size={12} />重命名
            </button>
          )}
          {remoteSelected && (
            <button
              className="ds-btn ds-btn--danger-subtle ds-btn--sm"
              type="button"
              onClick={() => void handleDelete(remoteSelected)}
            >
              <Icon name="trash" size={12} />删除
            </button>
          )}
          {localSelected && (
            <button
              className="ds-btn ds-btn--secondary ds-btn--sm"
              type="button"
              onClick={() =>
                void (localSelected.isDir
                  ? doUploadDir(localSelected)
                  : doUpload(localSelected))
              }
            >
              <Icon name="upload" size={12} />
              {localSelected.isDir ? "上传目录" : "上传"}
            </button>
          )}
          {remoteSelected && (
            <button
              className="ds-btn ds-btn--secondary ds-btn--sm"
              type="button"
              onClick={() =>
                void (remoteSelected.isDir
                  ? doDownloadDir(remoteSelected)
                  : doDownload(remoteSelected))
              }
            >
              <Icon name="download" size={12} />
              {remoteSelected.isDir ? "下载目录" : "下载"}
            </button>
          )}
        </div>
      </div>
      <div className="sftp-panes">
        <FsPane
          title="远程"
          side="remote"
          path={remoteDraft}
          items={remoteItems}
          selected={remoteSelected}
          dropHover={dropHover === "remote"}
          onSelect={useApp.getState().selectRemote}
          onOpen={(it) => handleOpen("remote", it)}
          onUp={() => void useApp.getState().upRemote()}
          onPathChange={setRemoteDraft}
          onPathSubmit={() => {
            useApp.setState({ remotePath: remoteDraft });
            void useApp.getState().loadRemote();
          }}
          onTargetHover={setHover}
          onPaneDrop={handlePaneDrop("remote")}
          onRowContextMenu={(e, it) => {
            useApp.getState().selectRemote(it);
            setCtx({ x: e.clientX, y: e.clientY, side: "remote", item: it });
          }}
          onBlankContextMenu={(e) =>
            setCtx({ x: e.clientX, y: e.clientY, side: "remote", item: null })
          }
        />
        <FsPane
          title="本地"
          side="local"
          path={localDraft}
          items={localItems}
          selected={localSelected}
          dropHover={dropHover === "local"}
          onSelect={useApp.getState().selectLocal}
          onOpen={(it) => handleOpen("local", it)}
          onUp={() => void useApp.getState().upLocal()}
          onPathChange={setLocalDraft}
          onPathSubmit={() => {
            useApp.setState({ localPath: localDraft });
            void useApp.getState().loadLocal();
          }}
          onTargetHover={setHover}
          onPaneDrop={handlePaneDrop("local")}
          onRowContextMenu={(e, it) => {
            useApp.getState().selectLocal(it);
            setCtx({ x: e.clientX, y: e.clientY, side: "local", item: it });
          }}
          onBlankContextMenu={(e) =>
            setCtx({ x: e.clientX, y: e.clientY, side: "local", item: null })
          }
        />
      </div>

      {ctx && (
        <div
          className="ctx-menu"
          ref={ctxRef}
          style={{ left: ctx.x, top: ctx.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {sftpContextMenu(ctx.side, ctx.item).map((m) => (
            <Fragment key={m.id}>
              {m.dividerBefore && <div className="ctx-menu__sep" />}
              <button
                type="button"
                className={
                  "ctx-menu__item" + (m.dangerous ? " ctx-menu__item--danger" : "")
                }
                onClick={() => runMenuAction(m)}
              >
                <Icon name={m.icon} size={12} />
                {m.label}
              </button>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
