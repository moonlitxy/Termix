import { Fragment, useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { useT } from "../lib/i18n";
import { useApp, dirname, joinPath } from "../store/app";
import { ipc, onTransferProgress } from "../lib/ipc";
import { confirmDialog, promptDialog, toast } from "../store/feedback";
import { sftpContextMenu, type SftpMenuItem } from "../lib/sftpMenu";
import { useClampedMenuPosition } from "../lib/contextMenu";
import { filterLocalItems, sortLocalItems } from "../lib/localFiles";
import { loadSettings, saveSettings } from "../lib/settings";
import type { SftpItem } from "../types";

function formatSize(n: number): string {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  if (n < 1024 * 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
  return (n / 1024 / 1024 / 1024 / 1024).toFixed(2) + " TB";
}

function formatMtime(ts: number): string {
  if (!ts) return "-";
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function LocalFilesPane() {
  const tr = useT();
  const localPath = useApp((s) => s.localPath);
  const remotePath = useApp((s) => s.remotePath);
  const sftpContext = useApp((s) => s.sftpContext);
  const [draft, setDraft] = useState(localPath);
  const [items, setItems] = useState<SftpItem[]>([]);
  const [selected, setSelected] = useState<SftpItem | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [dropHover, setDropHover] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterQuery, setFilterQuery] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);
  const [ctx, setCtx] = useState<{
    x: number;
    y: number;
    item: SftpItem | null;
  } | null>(null);
  const ctxRef = useRef<HTMLDivElement>(null);
  const ctxPosition = useClampedMenuPosition(ctx, ctxRef);

  useEffect(() => {
    setDraft(localPath);
    let cancelled = false;
    if (!localPath) {
      setItems([]);
      return;
    }
    setLoading(true);
    setError(null);
    ipc
      .localList(localPath)
      .then((list) => {
        if (cancelled) return;
        setItems(sortLocalItems(list));
        setSelected(null);
      })
      .catch((e) => {
        if (!cancelled) {
          setItems([]);
          setError(String(e));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [localPath, reloadKey]);

  useEffect(() => {
    let un: (() => void) | undefined;
    onTransferProgress((e) => {
      if (e.status === "completed" && e.direction === "download") {
        setReloadKey((key) => key + 1);
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

  useEffect(() => {
    if (!ctx) return;
    const onDown = (event: MouseEvent) => {
      if (ctxRef.current && !ctxRef.current.contains(event.target as Node)) {
        setCtx(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [ctx]);

  const openPath = (path: string) => {
    useApp.setState({ localPath: path });
    saveSettings({ ...loadSettings(), lastLocalPath: path });
  };

  const uploadItem = async (item: SftpItem) => {
    if (!sftpContext) return;
    const target = joinPath(remotePath, item.name);
    try {
      if (item.isDir) {
        await ipc.sftpUploadDir(
          sftpContext.connectionId,
          sftpContext.sessionId,
          item.path,
          target
        );
      } else {
        await ipc.sftpUpload(
          sftpContext.connectionId,
          sftpContext.sessionId,
          item.path,
          target
        );
      }
      toast.success(tr("sftp.queuedUpload", { n: item.name }));
    } catch (e) {
      toast.error(tr("local.uploadFailed", { e: String(e) }));
    }
  };

  const upload = async () => {
    if (selected) await uploadItem(selected);
  };

  const runMenuAction = (action: SftpMenuItem, item: SftpItem | null) => {
    if (action.id === "upload" && item) {
      void uploadItem(item);
    } else if (action.id === "rename" && item) {
      void renameItem(item);
    } else if (action.id === "delete" && item) {
      void deleteItem(item);
    } else if (action.id === "mkdir") {
      void createFolder();
    } else if (action.id === "copyPath" && item) {
      void navigator.clipboard
        .writeText(item.path)
        .then(() => toast.success(tr("local.pathCopied")))
        .catch(() => toast.error(tr("local.copyFailed")));
    } else if (action.id === "refresh") {
      setReloadKey((key) => key + 1);
    }
    setCtx(null);
  };

  const visibleItems = filterLocalItems(items, filterQuery);

  const createFolder = async () => {
    if (!localPath) return;
    const name = await promptDialog({
      title: tr("local.newFolder"),
      placeholder: tr("local.folderName"),
      confirmText: tr("sftp.create"),
    });
    const trimmed = name?.trim();
    if (!trimmed) return;
    try {
      await ipc.localMkdir(joinPath(localPath, trimmed));
      setReloadKey((key) => key + 1);
      toast.success(tr("local.created", { n: trimmed }));
    } catch (e) {
      toast.error(tr("local.createFailed", { e: String(e) }));
    }
  };

  const renameItem = async (item: SftpItem) => {
    const name = await promptDialog({
      title: tr("local.renameTitle"),
      defaultValue: item.name,
      confirmText: tr("local.rename"),
    });
    const trimmed = name?.trim();
    if (!trimmed || trimmed === item.name) return;
    try {
      await ipc.localRename(item.path, joinPath(dirname(item.path), trimmed));
      setReloadKey((key) => key + 1);
      toast.success(tr("local.renamed", { n: trimmed }));
    } catch (e) {
      toast.error(tr("local.renameFailed", { e: String(e) }));
    }
  };

  const deleteItem = async (item: SftpItem) => {
    const confirmed = await confirmDialog({
      title: tr("local.deleteTitle"),
      message: tr("local.deleteMsg", { d: item.isDir ? tr("sftp.typeDir") : tr("sftp.typeFile"), n: item.name }),
      confirmText: tr("local.delete"),
      danger: true,
    });
    if (!confirmed) return;
    try {
      await ipc.localDelete(item.path, item.isDir);
      setReloadKey((key) => key + 1);
      toast.success(tr("local.deleted", { n: item.name }));
    } catch (e) {
      toast.error(tr("local.deleteFailed", { e: String(e) }));
    }
  };

  const dropRemoteFile = async (e: React.DragEvent) => {
    e.preventDefault();
    setDropHover(false);
    const remoteItemPath = e.dataTransfer.getData("application/x-termix-remote");
    if (!remoteItemPath || !localPath || !sftpContext) return;
    const name = remoteItemPath.split(/[\\/]/).pop();
    if (!name) return;
    const isDir = e.dataTransfer.getData("application/x-termix-remote-dir") === "1";
    const target = joinPath(localPath, name);
    try {
      const exists = (await ipc.localList(localPath)).some(
        (item) => item.name === name
      );
      if (exists) {
        const confirmed = await confirmDialog({
          title: tr("sftp.overwriteTitle"),
          message: tr("local.overwriteMsg", { n: name }),
          confirmText: tr("sftp.overwrite"),
          danger: true,
        });
        if (!confirmed) return;
      }
      if (isDir) {
        await ipc.sftpDownloadDir(
          sftpContext.connectionId,
          sftpContext.sessionId,
          remoteItemPath,
          target
        );
      } else {
        await ipc.sftpDownload(
          sftpContext.connectionId,
          sftpContext.sessionId,
          remoteItemPath,
          target
        );
      }
      toast.success(tr("local.queuedDownload", { n: name }));
    } catch (err) {
      toast.error(tr("local.downloadFailed", { e: String(err) }));
    }
  };

  return (
    <div className="local-files">
      <div className="local-files__head">
        <span className="local-files__title">
          <Icon name="folder" size={13} />
          {tr("local.title")}
        </span>
        <button
          className={
            "ds-btn ds-btn--tertiary ds-btn--icon" +
            (filterOpen ? " is-active" : "")
          }
          type="button"
          title={tr("local.filterTitle")}
          onClick={() => {
            const next = !filterOpen;
            setFilterOpen(next);
            if (next) {
              window.setTimeout(() => filterRef.current?.focus(), 30);
            } else {
              setFilterQuery("");
            }
          }}
        >
          <Icon name="search" size={13} />
        </button>
        <button
          className="ds-btn ds-btn--tertiary ds-btn--icon"
          type="button"
          title={tr("local.refreshTitle")}
          disabled={!localPath || loading}
          onClick={() => setReloadKey((key) => key + 1)}
        >
          <Icon name="refresh" size={13} />
        </button>
        <button
          className="ds-btn ds-btn--tertiary ds-btn--icon"
          type="button"
          title={tr("local.openInFinder")}
          disabled={!localPath}
          onClick={() => {
            const target = selected
              ? selected.isDir
                ? selected.path
                : dirname(selected.path)
              : localPath;
            void ipc.localOpenPath(target).catch((e) => {
              toast.error(tr("local.openFailed", { e: String(e) }));
            });
          }}
        >
          <Icon name="arrow-right-to-line" size={13} />
        </button>
        <button
          className="ds-btn ds-btn--brand ds-btn--sm"
          type="button"
          title={tr("local.uploadSelTitle")}
          disabled={!selected || !sftpContext}
          onClick={() => void upload()}
        >
          <Icon name="upload" size={12} />
          上传
        </button>
      </div>
      <div className="local-files__path">
        <button
          className="ds-btn ds-btn--tertiary ds-btn--icon"
          type="button"
          title={tr("local.up")}
          disabled={!localPath}
          onClick={() => openPath(dirname(localPath))}
        >
          <Icon name="arrow-up" size={12} />
        </button>
        <input
          className="local-files__path-input"
          value={draft}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") openPath(draft.trim());
          }}
        />
      </div>
      {filterOpen && (
        <div className="local-files__filter">
          <Icon name="search" size={12} />
          <input
            ref={filterRef}
            value={filterQuery}
            placeholder={tr("local.filterPh")}
            spellCheck={false}
            onChange={(e) => setFilterQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setFilterOpen(false);
                setFilterQuery("");
              }
            }}
          />
        </div>
      )}
      <div
        className={
          "local-files__list" + (dropHover ? " is-drop-target" : "")
        }
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("application/x-termix-remote")) {
            return;
          }
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setDropHover(true);
        }}
        onDragLeave={() => setDropHover(false)}
        onDrop={(e) => void dropRemoteFile(e)}
        onContextMenu={(e) => {
          if (e.target !== e.currentTarget) return;
          e.preventDefault();
          setCtx({ x: e.clientX, y: e.clientY, item: null });
        }}
      >
        {loading && <div className="local-files__empty">加载中…</div>}
        {!loading && error && (
          <div className="local-files__empty" title={error}>
            目录加载失败
          </div>
        )}
        {!loading && !error && visibleItems.length === 0 && (
          <div className="local-files__empty">
            {filterQuery.trim() ? tr("sftp.noMatch") : tr("local.empty")}
          </div>
        )}
        {!loading &&
          !error &&
          visibleItems.map((item) => (
            <div
              key={item.path}
              className={
                "local-files__row" +
                (selected?.path === item.path ? " is-active" : "")
              }
              role="button"
              tabIndex={0}
              title={item.path}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setSelected(item);
                setCtx({ x: e.clientX, y: e.clientY, item });
              }}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("application/x-termix-local", item.path);
                e.dataTransfer.setData("text/plain", item.path);
                e.dataTransfer.effectAllowed = "copy";
                if (item.isDir) {
                  e.dataTransfer.setData("application/x-termix-local-dir", "1");
                }
              }}
              onClick={() => setSelected(item)}
              onDoubleClick={() => item.isDir && openPath(item.path)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (item.isDir) openPath(item.path);
                  else setSelected(item);
                }
              }}
            >
              <span className="local-files__icon">
                <Icon name={item.isDir ? "folder" : "file"} size={13} />
              </span>
              <span className="local-files__name">{item.name}</span>
              <span className="local-files__meta">
                {item.isDir ? tr("sftp.typeDir") : formatSize(item.size)}
              </span>
              <span className="local-files__time">{formatMtime(item.mtime)}</span>
            </div>
          ))}
        {ctx && (
          <div
            className="ctx-menu"
            ref={ctxRef}
            style={{ left: ctxPosition?.x ?? ctx.x, top: ctxPosition?.y ?? ctx.y }}
            onClick={(e) => e.stopPropagation()}
          >
            {sftpContextMenu("local", ctx.item).map((action) => (
              <Fragment key={action.id}>
                {action.dividerBefore && <div className="ctx-menu__sep" />}
                <button
                  type="button"
                  className={
                    "ctx-menu__item" +
                    (action.dangerous ? " ctx-menu__item--danger" : "")
                  }
                  onClick={() => runMenuAction(action, ctx.item)}
                >
                  <Icon name={action.icon} size={12} />
                  {action.label}
                </button>
              </Fragment>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
