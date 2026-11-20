import { useEffect, useMemo, useState } from "react";
import { Icon } from "./Icon";
import { ipc } from "../lib/ipc";
import { useApp } from "../store/app";
import {
  FONT_FAMILIES,
  applyAppearance,
  loadSettings,
  saveSettings,
  type Settings,
} from "../lib/settings";
import {
  CUSTOM_MIRROR_ID,
  UPDATE_MIRRORS,
  describeUpdateEndpoint,
  describeUpdateSource,
  normalizeMirrorBase,
  normalizeProxyUrl,
  resolveUpdateEndpoint,
} from "../lib/updateSource";
import { formatBytes } from "../lib/formatBytes";
import { useT } from "../lib/i18n";
import { useUpdate } from "../store/update";
import { confirmDialog, toast } from "../store/feedback";
import { isWindowsPlatform } from "../lib/windowControls";
import type { AppPaths, BackupFile, MasterStatus } from "../types";

interface Category {
  id: "general" | "terminal" | "security" | "monitor" | "update";
  labelKey: string;
  icon: string;
  desc: string;
}

const CATEGORIES: Category[] = [
  { id: "general", labelKey: "st.cat.general", icon: "settings", desc: "基础外观、界面语言与偏好交互设置" },
  { id: "terminal", labelKey: "st.cat.terminal", icon: "terminal", desc: "终端外观、光标样式与滚动缓冲区" },
  { id: "security", labelKey: "st.cat.security", icon: "key", desc: "主密码保护、目录路径与快照备份" },
  { id: "monitor", labelKey: "st.cat.monitor", icon: "bar", desc: "系统性能与资源指标刷新频率" },
  { id: "update", labelKey: "st.cat.updates", icon: "download", desc: "版本检查、镜像加速与网络代理设置" },
];

export function SettingsView() {
  const t = useT();
  const tab = useApp((s) => s.settingsTab);
  const setTab = useApp((s) => s.setSettingsTab);
  const [searchQuery, setSearchQuery] = useState("");
  const [settings, setSettings] = useState<Settings>(loadSettings);

  useEffect(() => {
    applyAppearance(settings);
    saveSettings(settings);
  }, [settings]);

  const set = (patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch }));

  // ---- 文件与数据目录 ----
  const [appPaths, setAppPaths] = useState<AppPaths | null>(null);
  const [downloadDraft, setDownloadDraft] = useState("");
  const [savingDownloadDir, setSavingDownloadDir] = useState(false);

  useEffect(() => {
    let cancelled = false;
    ipc
      .appPaths()
      .then((paths) => {
        if (cancelled) return;
        setAppPaths(paths);
        setDownloadDraft(paths.downloadDir);
        useApp.getState().setAppPaths(paths);
      })
      .catch(() => {
        /* browser mode */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const saveDownloadDir = async (value: string) => {
    if (savingDownloadDir) return;
    setSavingDownloadDir(true);
    try {
      const paths = await ipc.downloadDirSet(value.trim() || null);
      setAppPaths(paths);
      setDownloadDraft(paths.downloadDir);
      useApp.getState().setAppPaths(paths);
      useApp.setState({ localPath: paths.downloadDir });
      toast.success(t("st.downloadDirSaved"));
    } catch (e) {
      toast.error(t("st.downloadDirFailed", { e: String(e) }));
    } finally {
      setSavingDownloadDir(false);
    }
  };

  // ---- 软件更新 ----
  const checking = useUpdate((s) => s.checking);
  const [updateMsg, setUpdateMsg] = useState<string | null>(null);

  const handleCheckUpdate = async () => {
    setUpdateMsg(null);
    const info = await useUpdate.getState().check();
    if (!info) {
      setUpdateMsg(useUpdate.getState().error ?? t("st.updateCheckFailed"));
      return;
    }
    if (info.hasUpdate) {
      setUpdateMsg(t("st.updateFound", { v: info.latestVersion }));
      useUpdate.getState().openDialog();
    } else {
      setUpdateMsg(t("st.updateLatest", { v: info.currentVersion }));
    }
  };

  // ---- 更新源：用当前表单值直测连通性（不经过保存也能验证） ----
  // 表单修改即自动保存，此处直接用当前表单值测试
  const handleTestUpdateEndpoint = async () => {
    setUpdateMsg(null);
    const r = resolveUpdateEndpoint(settings);
    if ("error" in r) {
      setUpdateMsg(t("st.configInvalid", { e: r.error }));
      return;
    }
    setUpdateMsg(t("st.testing"));
    try {
      const info = await ipc.checkUpdate(r.mirror || null, r.proxy || null);
      setUpdateMsg(
        t("st.testOkVia", { src: describeUpdateSource(info.source), v: info.latestVersion })
      );
    } catch (e) {
      setUpdateMsg(t("st.testFailed", { e: String(e) }));
    }
  };

  // ---- 安全：主密码 ----
  const [master, setMaster] = useState<MasterStatus>({ hasMaster: false, unlocked: false });
  const [newPass, setNewPass] = useState("");
  const [confirmPass, setConfirmPass] = useState("");
  const [oldPass, setOldPass] = useState("");
  const [unlockPass, setUnlockPass] = useState("");

  // ---- 数据备份：本地滚动快照 ----
  const [backups, setBackups] = useState<BackupFile[]>([]);
  const refreshBackups = async () => {
    try {
      setBackups(await ipc.backupList());
    } catch {
      /* ignore */
    }
  };
  useEffect(() => {
    void refreshBackups();
  }, []);

  const formatBackupTime = (ms: number) => {
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const handleBackupNow = async () => {
    try {
      const msg = await ipc.backupNow();
      toast.success(msg);
      await refreshBackups();
    } catch (e) {
      toast.error(t("st.backupFailed", { e: String(e) }));
    }
  };

  const handleBackupRestore = async (name: string) => {
    const ok = await confirmDialog({
      title: t("st.restoreConfirmTitle"),
      message: t("st.restoreConfirmMsg", { n: name }),
      confirmText: t("st.restoreConfirm"),
    });
    if (!ok) return;
    try {
      const res = await ipc.backupRestore(name);
      const { loadSessions, loadGroups } = useApp.getState();
      await loadSessions();
      await loadGroups();
      await refreshBackups();
      toast.success(
        t("st.restoreDone", { c: res.sessionsCreated, s: res.sessionsSkipped })
      );
    } catch (e) {
      toast.error(t("st.restoreFailed", { e: String(e) }));
    }
  };

  const refreshMaster = () => {
    ipc
      .masterStatus()
      .then(setMaster)
      .catch(() => {});
  };
  useEffect(() => {
    void refreshMaster();
  }, []);

  const doSet = async () => {
    if (newPass.length < 4) {
      toast.warning(t("st.masterTooShort"));
      return;
    }
    if (newPass !== confirmPass) {
      toast.warning(t("st.masterMismatch"));
      return;
    }
    try {
      await ipc.masterSet(newPass, master.hasMaster ? oldPass : undefined);
      setNewPass("");
      setConfirmPass("");
      setOldPass("");
      refreshMaster();
      toast.success(master.hasMaster ? t("st.masterChanged") : t("st.masterSet"));
    } catch (e) {
      toast.error(String(e));
    }
  };

  const doUnlock = async () => {
    try {
      await ipc.masterUnlock(unlockPass);
      setUnlockPass("");
      refreshMaster();
      toast.success(t("st.unlockedMsg"));
    } catch (e) {
      toast.error(String(e));
    }
  };

  const doLock = async () => {
    try {
      await ipc.masterLock();
      refreshMaster();
      toast.success(t("st.lockedMsg"));
    } catch (e) {
      toast.error(String(e));
    }
  };

  const doClear = async () => {
    const confirmed = await confirmDialog({
      title: t("st.clearMaster"),
      message: t("st.clearMasterMsg"),
      confirmText: t("st.clear"),
      danger: true,
    });
    if (!confirmed) return;
    try {
      await ipc.masterClear(unlockPass);
      setUnlockPass("");
      refreshMaster();
      toast.success(t("st.cleared"));
    } catch (e) {
      toast.error(String(e));
    }
  };

  const filteredCategories = useMemo(() => {
    if (!searchQuery.trim()) return CATEGORIES;
    const q = searchQuery.trim().toLowerCase();
    return CATEGORIES.filter(
      (c) =>
        t(c.labelKey).toLowerCase().includes(q) ||
        c.desc.toLowerCase().includes(q)
    );
  }, [searchQuery, t]);

  const currentCat = CATEGORIES.find((c) => c.id === tab) ?? CATEGORIES[0];

  return (
    <div className="st-view st-view--split">
      <div className="st-nav">
        <div className="st-nav__head">
          <div className="st-nav__title">
            <Icon name="settings" size={16} />
            <span>{t("st.title")}</span>
          </div>
          <div className="st-nav__search">
            <Icon name="search" size={12} />
            <input
              className="st-nav__search-input"
              value={searchQuery}
              placeholder={t("st.searchPh")}
              spellCheck={false}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </div>
        <div className="st-nav__list">
          {filteredCategories.map((c) => (
            <button
              key={c.id}
              type="button"
              className={"st-nav__item" + (tab === c.id ? " is-active" : "")}
              onClick={() => setTab(c.id)}
            >
              <Icon name={c.icon} size={15} />
              <span>{t(c.labelKey)}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="st-main">
        <div className="st-main__head">
          <div className="st-main__head-info">
            <h2 className="st-main__title">{t(currentCat.labelKey)}</h2>
            <p className="st-main__desc">{currentCat.desc}</p>
          </div>
          <button
            className="ds-btn ds-btn--tertiary ds-btn--icon st-main__close"
            type="button"
            title={t("st.backToTerminal")}
            onClick={() => useApp.setState({ activity: "terminal" })}
          >
            <Icon name="x" size={15} />
          </button>
        </div>

        <div className="st-body st-main__body" data-active-cat={tab}>
        <div className="ds-card st-section" data-cat="general">
          <div className="res-card__head">
            <span className="res-card__label">
              <Icon name="settings" size={14} />{t("st.general")}</span>
          </div>
          <div className="st-row">
            <label>{t("st.theme")}</label>
            <div className="st-radio-group" role="radiogroup" aria-label={t("st.theme")}>
              {(
                [
                  ["dark", t("st.theme.dark")],
                  ["light", t("st.theme.light")],
                ] as const
              ).map(([value, label]) => (
                <label className="ds-radio" key={value}>
                  <input
                    type="radio"
                    name="settings-theme"
                    checked={settings.theme === value}
                    onChange={() => set({ theme: value })}
                  />
                  <span className="ds-radio__dot" />
                  {label}
                </label>
              ))}
            </div>
          </div>
          <div className="st-row">
            <label>{t("st.fontFamily")}</label>
            <select
              className="ds-select st-input"
              value={settings.fontFamily}
              onChange={(e) =>
                set({ fontFamily: e.target.value as Settings["fontFamily"] })
              }
            >
              {FONT_FAMILIES.map((font) => (
                <option key={font.id} value={font.id}>
                  {t(font.labelKey)}
                </option>
              ))}
            </select>
          </div>
          <div className="st-hint">{t("st.fontFamilyHint")}</div>
          <div className="st-row">
            <label>{t("st.fontSize")}</label>
            <input
              className="ds-input st-input"
              type="number"
              min={11}
              max={16}
              value={settings.fontSize}
              onChange={(e) => set({ fontSize: Number(e.target.value) || 13 })}
            />
          </div>
          <div className="st-row">
            <label>{t("st.language")}</label>
            <select
              className="ds-select st-input"
              value={settings.lang}
              onChange={(e) => set({ lang: e.target.value as Settings["lang"] })}
            >
              <option value="zh">{t("st.lang.zh")}</option>
              <option value="en">{t("st.lang.en")}</option>
            </select>
          </div>
          <div className="st-hint">{t("st.languageHint")}</div>
        </div>

        <div className="ds-card st-section" data-cat="security">
          <div className="res-card__head">
            <span className="res-card__label">
              <Icon name="folder" size={14} />{t("st.storage")}
            </span>
          </div>
          <div className="st-row st-row--col">
            <label>{t("st.dataDir")}</label>
            <div className="st-path-row">
              <span className="st-path-value" title={appPaths?.dataDir}>
                {appPaths?.dataDir ?? "-"}
              </span>
              <button
                className="ds-btn ds-btn--secondary ds-btn--sm"
                type="button"
                disabled={!appPaths}
                onClick={() => {
                  if (appPaths) void ipc.localOpenPath(appPaths.dataDir);
                }}
              >
                {t("st.openDir")}
              </button>
            </div>
            <div className="st-hint">{t("st.dataDirHint")}</div>
            {isWindowsPlatform() && appPaths && !appPaths.portable && (
              <div className="st-hint st-hint--error">{t("st.portableFallback")}</div>
            )}
          </div>
          <div className="st-row st-row--col">
            <label>{t("st.downloadDir")}</label>
            <div className="st-input-group st-input-group--wide">
              <input
                className="ds-input"
                value={downloadDraft}
                spellCheck={false}
                placeholder={appPaths?.defaultDownloadDir ?? ""}
                onChange={(e) => setDownloadDraft(e.target.value)}
                onBlur={() => {
                  if (downloadDraft.trim() !== (appPaths?.downloadDir ?? "")) {
                    void saveDownloadDir(downloadDraft);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void saveDownloadDir(downloadDraft);
                  }
                }}
              />
              <button
                className="ds-btn ds-btn--secondary ds-btn--sm"
                type="button"
                disabled={!appPaths}
                onClick={() => {
                  if (appPaths) void ipc.localOpenPath(appPaths.downloadDir);
                }}
              >
                {t("st.openDir")}
              </button>
              <button
                className="ds-btn ds-btn--secondary ds-btn--sm"
                type="button"
                disabled={savingDownloadDir}
                onClick={() => void saveDownloadDir("")}
              >
                {t("st.resetDefault")}
              </button>
            </div>
            <div className="st-hint">
              {t("st.downloadDirHint", {
                path: appPaths?.defaultDownloadDir ?? "-",
              })}
            </div>
          </div>
        </div>

        <div className="ds-card st-section" data-cat="terminal">
          <div className="res-card__head">
            <span className="res-card__label">
              <Icon name="terminal" size={14} />{t("st.terminal")}
            </span>
          </div>
          <div className="st-row">
            <label>{t("st.cursor")}</label>
            <select
              className="ds-select st-input"
              value={settings.cursorStyle}
              onChange={(e) => set({ cursorStyle: e.target.value as Settings["cursorStyle"] })}
            >
              <option value="block">{t("st.cursor.block")}</option>
              <option value="underline">{t("st.cursor.underline")}</option>
              <option value="bar">{t("st.cursor.bar")}</option>
            </select>
          </div>
          <div className="st-row">
            <label>{t("st.scrollback")}</label>
            <select
              className="ds-select st-input"
              value={settings.scrollback}
              onChange={(e) => set({ scrollback: Number(e.target.value) })}
            >
              <option value={1000}>{t("st.lines", { n: 1000 })}</option>
              <option value={5000}>{t("st.lines", { n: 5000 })}</option>
              <option value={10000}>{t("st.lines", { n: 10000 })}</option>
            </select>
          </div>
        </div>

        <div className="ds-card st-section" data-cat="monitor">
          <div className="res-card__head">
            <span className="res-card__label">
              <Icon name="bar" size={14} />{t("st.monitor")}
            </span>
          </div>
          <div className="st-row">
            <label>{t("st.interval")}</label>
            <select
              className="ds-select st-input"
              value={settings.monitorInterval}
              onChange={(e) => set({ monitorInterval: Number(e.target.value) })}
            >
              <option value={1000}>{t("st.sec", { n: 1 })}</option>
              <option value={2000}>{t("st.sec", { n: 2 })}</option>
              <option value={5000}>{t("st.sec", { n: 5 })}</option>
            </select>
          </div>
        </div>

        <div className="ds-card st-section" data-cat="security">
          <div className="res-card__head">
            <span className="res-card__label">
              <Icon name="key" size={14} />安全
            </span>
            {master.hasMaster && (
              <span className={"ds-tag " + (master.unlocked ? "ds-tag--success" : "ds-tag--neutral")}>
                {master.unlocked ? t("st.unlocked") : t("st.locked")}
              </span>
            )}
          </div>
          <div className="st-row">
            <label>{t("st.securityStatus")}</label>
            <span className="st-kbd">
              {master.hasMaster ? t("st.hasMaster") : t("st.noMaster")}
            </span>
          </div>

          {master.hasMaster && !master.unlocked && (
            <>
              <div className="st-row">
                <label>{t("st.unlock")}</label>
                <input
                  className="ds-input st-input"
                  type="password"
                  value={unlockPass}
                  onChange={(e) => setUnlockPass(e.target.value)}
                  placeholder={t("st.masterUnlockPh")}
                />
              </div>
              <div className="st-row">
                <label />
                <div className="st-actions">
                  <button className="ds-btn ds-btn--brand ds-btn--sm" type="button" title={t("st.unlockTitle")} onClick={() => void doUnlock()}>{t("st.unlock")}</button>
                  <button className="ds-btn ds-btn--danger-subtle ds-btn--sm" type="button" title={t("st.clearMasterTitle")} onClick={() => void doClear()}>{t("st.clearMaster")}</button>
                </div>
              </div>
            </>
          )}

          {master.hasMaster && master.unlocked && (
            <>
              <div className="st-row">
                <label>{t("st.changeMaster")}</label>
                <div className="st-input-group">
                  <input
                    className="ds-input"
                    type="password"
                    value={oldPass}
                    onChange={(e) => setOldPass(e.target.value)}
                    placeholder={t("st.oldMasterPh")}
                  />
                  <input
                    className="ds-input"
                    type="password"
                    value={newPass}
                    onChange={(e) => setNewPass(e.target.value)}
                    placeholder={t("st.newMasterPh")}
                  />
                  <input
                    className="ds-input"
                    type="password"
                    value={confirmPass}
                    onChange={(e) => setConfirmPass(e.target.value)}
                    placeholder={t("st.confirmNewMasterPh")}
                  />
                </div>
              </div>
              <div className="st-row">
                <label />
                <div className="st-actions">
                  <button className="ds-btn ds-btn--brand ds-btn--sm" type="button" title={t("st.changeMasterTitle")} onClick={() => void doSet()}>{t("st.changeMaster")}</button>
                  <button className="ds-btn ds-btn--secondary ds-btn--sm" type="button" title={t("st.lockTitle")} onClick={() => void doLock()}>{t("st.lock")}</button>
                </div>
              </div>
            </>
          )}

          {!master.hasMaster && (
            <>
              <div className="st-row">
                <label>{t("st.setMaster")}</label>
                <div className="st-input-group">
                  <input
                    className="ds-input"
                    type="password"
                    value={newPass}
                    onChange={(e) => setNewPass(e.target.value)}
                    placeholder={t("st.setMasterPh")}
                  />
                  <input
                    className="ds-input"
                    type="password"
                    value={confirmPass}
                    onChange={(e) => setConfirmPass(e.target.value)}
                    placeholder={t("st.confirmMasterPh")}
                  />
                </div>
              </div>
              <div className="st-row">
                <label />
                <button className="ds-btn ds-btn--brand ds-btn--sm" type="button" title={t("st.setMasterTitle")} onClick={() => void doSet()}>{t("st.setMaster")}</button>
              </div>
            </>
          )}
          <div className="st-hint">{t("st.securityHint")}</div>
        </div>

        <div className="ds-card st-section" data-cat="security">
          <div className="res-card__head">
            <span className="res-card__label">
              <Icon name="copy" size={14} />{t("st.backup")}</span>
            <div className="st-actions">
              <button
                className="ds-btn ds-btn--secondary ds-btn--sm"
                type="button"
                title={t("st.backupNowTitle")}
                onClick={() => void handleBackupNow()}
              >{t("st.backupNow")}</button>
            </div>
          </div>
          <div className="st-row st-row--col">
            <label>{t("st.backupListLabel")}</label>
            {backups.length === 0 ? (
              <div className="st-hint">{t("st.backupEmpty")}</div>
            ) : (
              <div className="st-backup-list">
                {backups.map((b) => (
                  <div className="st-backup-row" key={b.name}>
                    <span className="st-backup-name" title={b.name}>
                      {formatBackupTime(b.modifiedMs)} · {formatBytes(b.size)}
                    </span>
                    <button
                      className="ds-btn ds-btn--secondary ds-btn--sm"
                      type="button"
                      title={t("st.restoreTitle", { n: b.name })}
                      onClick={() => void handleBackupRestore(b.name)}
                    >{t("st.restore")}</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="ds-card st-section" data-cat="update">
          <div className="res-card__head">
            <span className="res-card__label">
              <Icon name="download" size={14} />{t("st.updates")}
            </span>
          </div>
          <div className="st-row">
            <label>{t("st.currentVersion")}</label>
            <span className="st-kbd">v{__TERMIX_VERSION__}</span>
          </div>
          <div className="st-row st-row--col">
            <label>{t("st.updateMode")}</label>
            <div className="st-seg" role="radiogroup" aria-label={t("st.updateMode")}>
              {(
                [
                  ["direct", t("st.mode.direct")],
                  ["mirror", t("st.mode.mirror")],
                  ["proxy", t("st.mode.proxy")],
                ] as const
              ).map(([mode, text]) => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={settings.updateMode === mode}
                  className={
                    "st-seg__btn" + (settings.updateMode === mode ? " is-active" : "")
                  }
                  title={mode === "direct" ? t("st.mode.directTitle") : mode === "mirror" ? t("st.mode.mirrorTitle") : t("st.mode.proxyTitle")}
                  onClick={() => set({ updateMode: mode })}
                >
                  {text}
                </button>
              ))}
            </div>
          </div>
          {settings.updateMode === "mirror" && (
            <>
              <div className="st-row st-row--col">
                <label>{t("st.mirrorSource")}</label>
                <select
                  className="ds-select"
                  value={settings.updateMirror}
                  onChange={(e) => set({ updateMirror: e.target.value })}
                >
                  {UPDATE_MIRRORS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                  <option value={CUSTOM_MIRROR_ID}>{t("st.mirrorCustom")}</option>
                </select>
              </div>
              {settings.updateMirror === CUSTOM_MIRROR_ID && (
                <div className="st-row st-row--col">
                  <label>自定义镜像地址</label>
                  <input
                    className="ds-input"
                    value={settings.customMirror}
                    placeholder={t("st.mirrorCustomPh")}
                    spellCheck={false}
                    onChange={(e) => set({ customMirror: e.target.value })}
                  />
                  {"error" in normalizeMirrorBase(settings.customMirror || " ") && settings.customMirror.trim() && (
                    <div className="st-hint st-hint--error">
                      {(normalizeMirrorBase(settings.customMirror) as { error: string }).error}
                    </div>
                  )}
                </div>
              )}
              <div className="st-hint">
                {(UPDATE_MIRRORS.find((m) => m.id === settings.updateMirror)?.tested ??
                  t("st.mirrorCustomHint"))}
              </div>
            </>
          )}
          {settings.updateMode === "proxy" && (
            <div className="st-row st-row--col">
              <label>{t("st.proxyAddr")}</label>
              <input
                className="ds-input"
                value={settings.updateProxy}
                placeholder={t("st.proxyPh")}
                spellCheck={false}
                onChange={(e) => set({ updateProxy: e.target.value })}
              />
              {"error" in normalizeProxyUrl(settings.updateProxy || " ") && settings.updateProxy.trim() && (
                <div className="st-hint st-hint--error">
                  {(normalizeProxyUrl(settings.updateProxy) as { error: string }).error}
                </div>
              )}
            </div>
          )}
          <div className="st-row">
            <label>{t("st.currentChannel")}</label>
            <span className="st-kbd">{describeUpdateEndpoint(settings)}</span>
          </div>
          <div className="st-row">
            <label />
            <div className="st-actions">
              <button
                className="ds-btn ds-btn--brand ds-btn--sm"
                type="button"
                disabled={checking}
                title={t("st.checkUpdateTitle")}
                onClick={() => void handleCheckUpdate()}
              >
                {checking ? t("st.checking") : t("st.check")}
              </button>
              <button
                className="ds-btn ds-btn--secondary ds-btn--sm"
                type="button"
                disabled={checking}
                title={t("st.testTitle")}
                onClick={() => void handleTestUpdateEndpoint()}
              >{t("st.test")}</button>
            </div>
          </div>
          {updateMsg && <div className="st-hint">{updateMsg}</div>}
        </div>
      </div>
      </div>
    </div>
  );
}
