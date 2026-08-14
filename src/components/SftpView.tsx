import { Fragment, useEffect, useMemo, useRef, useState } from "react";
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

/** 权限数值 → 符号模式（rwxr-xr-x；setuid 等特殊位省略展示） */
function formatPerms(perms?: number, isDir = false): string {
  if (perms === undefined) return "-";
  const mode = perms & 0o7777;
  let out = isDir ? "d" : "-";
  for (let i = 2; i >= 0; i--) {
    out += (mode >> (i * 3)) & 4 ? "r" : "-";
    out += (mode >> (i * 3)) & 2 ? "w" : "-";
    out += (mode >> (i * 3)) & 1 ? "x" : "-";
  }
  return out;
}

/** 用户/用户组（数值 uid/gid，服务端未返回时显示 -） */
function formatOwner(uid?: number, gid?: number): string {
  if (uid === undefined && gid === undefined) return "-";
  return `${uid ?? "-"}/${gid ?? "-"}`;
}

type SortKey = "name" | "size" | "mtime" | "perms" | "uid";
type SortDir = "asc" | "desc";

function cmpField(a: SftpItem, b: SftpItem, key: SortKey): number {
  switch (key) {
    case "name":
      return a.name.localeCompare(b.name, undefined, {
        numeric: true,
        sensitivity: "base",
      });
    case "size":
      return a.size - b.size;
    case "mtime":
      return a.mtime - b.mtime;
    case "perms":
      return (a.perms ?? -1) - (b.perms ?? -1);
    case "uid":
      return (a.uid ?? -1) - (b.uid ?? -1);
  }
}

export function SftpView() {
  const sftpContext = useApp((s) => s.sftpContext);
  const remotePath = useApp((s) => s.remotePath);
  const remoteItems = useApp((s) => s.remoteItems);
  const remoteSelected = useApp((s) => s.remoteSelected);
  const remoteLoading = useApp((s) => s.remoteLoading);
  const sessions = useApp((s) => s.sessions);
  const tabs = useApp((s) => s.tabs);

  const [remoteDraft, setRemoteDraft] = useState(remotePath);
  const [dropHover, setDropHover] = useState(false);
  const hoverRef = useRef(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({
    key: "name",
    dir: "asc",
  });
  const [ctx, setCtx] = useState<{
    x: number;
    y: number;
    item: SftpItem | null;
  } | null>(null);
  const ctxRef = useRef<HTMLDivElement>(null);
  const sftpCollapsed = useApp((s) => s.sftpCollapsed);
  const toggleSftpCollapsed = useApp((s) => s.toggleSftpCollapsed);
  const sessionName = sftpContext
    ? sessions.find((s) => s.id === sftpContext.sessionId)?.name ?? "已连接会话"
    : null;

  // 排序（目录始终优先分组，组内按所选字段升/降序）
  const sortedItems = useMemo(() => {
    const arr = [...remoteItems];
    arr.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      const r = cmpField(a, b, sort.key);
      return sort.dir === "asc" ? r : -r;
    });
    return arr;
  }, [remoteItems, sort]);

  const toggleSort = (key: SortKey) => {
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "asc" }
    );
  };

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

  // 挂载时：若已有已连接的会话但尚未建立 sftpContext，
  // 自动建立并展示根目录 "/"（store.setSftpContext 负责初始路径与加载）
  useEffect(() => {
    const st = useApp.getState();
    if (!st.sftpContext) {
      const conn = st.tabs.find(
        (t) => t.connectionId && t.status === "connected"
      );
      if (conn?.connectionId) {
        void st.setSftpContext(conn.sessionId, conn.connectionId);
      }
    }
  }, []);

  // 上传/下载任务完成后刷新对应目录（上传会改变当前远程目录内容，先失效缓存再重载）
  useEffect(() => {
    let un: (() => void) | undefined;
    onTransferProgress((e) => {
      if (e.status === "completed") {
        if (e.direction === "upload") {
          useApp.getState().invalidateRemoteCache();
          void useApp.getState().loadRemote();
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

  // 系统文件拖入（Tauri webview 事件）：拖到远程文件列表视为上传
  useEffect(() => {
    if (!("__TAURI__" in window)) return;
    let un: (() => void) | undefined;
    import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((ev) => {
          const p = ev.payload;
          if (p.type !== "drop" || !p.paths?.length) return;
          console.log("[sftp] system files dropped:", p.paths, "onPane:", hoverRef.current);
          const st = useApp.getState();
          if (!st.sftpContext) {
            window.alert("请先在左侧选择一个已连接的会话，再拖拽文件上传");
            return;
          }
          if (!hoverRef.current) {
            window.alert("请将文件拖到远程文件列表中上传");
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

  const handleOpen = (item: SftpItem) => {
    const st = useApp.getState();
    if (item.isDir) {
      void st.openRemoteDir(item);
    } else {
      void doDownload(item);
    }
  };

  // 刷新：失效缓存后强制重新拉取
  const handleRefresh = () => {
    const st = useApp.getState();
    st.invalidateRemoteCache();
    void st.loadRemote();
  };

  const handleMkdir = async () => {
    const st = useApp.getState();
    if (!st.sftpContext) return;
    const name = window.prompt("新建文件夹名称");
    if (!name) return;
    try {
      await ipc.sftpMkdir(st.sftpContext.connectionId, joinPath(st.remotePath, name));
      st.invalidateRemoteCache();
      void st.loadRemote();
    } catch (e) {
      window.alert(String(e));
    }
  };

  const handleDelete = async (item: SftpItem) => {
    const st = useApp.getState();
    if (!st.sftpContext) return;
    if (!window.confirm(`删除 ${item.name}？`)) return;
    try {
      await ipc.sftpRemove(st.sftpContext.connectionId, item.path, item.isDir);
      st.invalidateRemoteCache();
      void st.loadRemote();
    } catch (e) {
      window.alert(String(e));
    }
  };

  const handleRename = async (item: SftpItem) => {
    const st = useApp.getState();
    if (!st.sftpContext) return;
    const name = window.prompt("新名称", item.name);
    if (!name || name === item.name) return;
    const newPath = joinPath(item.path.replace(/\/[^/]+$/, ""), name);
    try {
      await ipc.sftpRename(st.sftpContext.connectionId, item.path, newPath);
      st.invalidateRemoteCache();
      void st.loadRemote();
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
        </span>
        <div className="sftp-pathbar">
          <button
            className="ds-btn ds-btn--tertiary ds-btn--sm"
            type="button"
            title="上级目录"
            onClick={() => void useApp.getState().upRemote()}
          >
            <Icon name="arrow-up" size={12} />
          </button>
          <input
            className="sftp-pathbar__input"
            value={remoteDraft}
            onChange={(e) => setRemoteDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                useApp.setState({ remotePath: remoteDraft });
                useApp.getState().invalidateRemoteCache();
                void useApp.getState().loadRemote();
              }
            }}
            spellCheck={false}
          />
        </div>
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
          <button
            className="ds-btn ds-btn--tertiary ds-btn--icon"
            type="button"
            title={
              sftpCollapsed
                ? "展开面板：显示远程文件列表（文件名、大小、类型、修改时间、权限、用户/组）"
                : "收起面板：隐藏文件列表，仅保留工具栏条"
            }
            onClick={toggleSftpCollapsed}
          >
            <Icon name={sftpCollapsed ? "chevron-up" : "chevron-down"} size={14} />
          </button>
        </div>
      </div>
      {!sftpCollapsed && (
        <div
          className={"sftp-list sftp-list--remote" + (dropHover ? " is-drop-target" : "")}
          onDragOver={(e) => {
            e.preventDefault();
            hoverRef.current = true;
            setDropHover(true);
          }}
          onDragLeave={() => {
            hoverRef.current = false;
            setDropHover(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            hoverRef.current = false;
            setDropHover(false);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            setCtx({ x: e.clientX, y: e.clientY, item: null });
          }}
        >
          <div className="sftp-head">
            <button
              type="button"
              className={
                "sftp-head__cell sftp-head__cell--name" +
                (sort.key === "name" ? " is-sorted" : "")
              }
              title="按名称排序"
              onClick={() => toggleSort("name")}
            >
              文件名{sort.key === "name" && (sort.dir === "asc" ? "↑" : "↓")}
            </button>
            <button
              type="button"
              className={
                "sftp-head__cell" + (sort.key === "size" ? " is-sorted" : "")
              }
              title="按大小排序"
              onClick={() => toggleSort("size")}
            >
              大小{sort.key === "size" && (sort.dir === "asc" ? "↑" : "↓")}
            </button>
            <span className="sftp-head__cell">类型</span>
            <button
              type="button"
              className={
                "sftp-head__cell" + (sort.key === "mtime" ? " is-sorted" : "")
              }
              title="按修改时间排序"
              onClick={() => toggleSort("mtime")}
            >
              修改时间{sort.key === "mtime" && (sort.dir === "asc" ? "↑" : "↓")}
            </button>
            <button
              type="button"
              className={
                "sftp-head__cell" + (sort.key === "perms" ? " is-sorted" : "")
              }
              title="按权限排序"
              onClick={() => toggleSort("perms")}
            >
              权限{sort.key === "perms" && (sort.dir === "asc" ? "↑" : "↓")}
            </button>
            <button
              type="button"
              className={
                "sftp-head__cell" + (sort.key === "uid" ? " is-sorted" : "")
              }
              title="按用户/组排序"
              onClick={() => toggleSort("uid")}
            >
              用户/组{sort.key === "uid" && (sort.dir === "asc" ? "↑" : "↓")}
            </button>
          </div>
          {remoteLoading && <div className="sftp-empty">加载中…</div>}
          {!remoteLoading &&
            sortedItems.map((it) => (
              <div
                key={it.path}
                className={
                  "sftp-row" + (remoteSelected?.path === it.path ? " is-active" : "")
                }
                onClick={() => useApp.getState().selectRemote(it)}
                onDoubleClick={() => handleOpen(it)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  useApp.getState().selectRemote(it);
                  setCtx({ x: e.clientX, y: e.clientY, item: it });
                }}
                title={it.path}
              >
                <span className="sftp-row__name">
                  <span className="sftp-row__icon">
                    <Icon name={it.isDir ? "folder" : "file"} size={13} />
                  </span>
                  <span className="sftp-row__label">{it.name}</span>
                </span>
                <span className="sftp-row__cell sftp-row__cell--num">
                  {it.isDir ? "-" : formatSize(it.size)}
                </span>
                <span className="sftp-row__cell">
                  {it.isDir ? "目录" : "文件"}
                </span>
                <span className="sftp-row__cell sftp-row__cell--time">
                  {formatMtime(it.mtime)}
                </span>
                <span className="sftp-row__cell sftp-row__cell--perms">
                  {formatPerms(it.perms, it.isDir)}
                </span>
                <span className="sftp-row__cell">
                  {formatOwner(it.uid, it.gid)}
                </span>
              </div>
            ))}
          {!remoteLoading && remoteItems.length === 0 && (
            <div className="sftp-empty">空目录</div>
          )}
          <div className="sftp-pane__hint">可拖拽本地文件到此处上传</div>
        </div>
      )}

      {ctx && (
        <div
          className="ctx-menu"
          ref={ctxRef}
          style={{ left: ctx.x, top: ctx.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {sftpContextMenu("remote", ctx.item).map((m) => (
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
