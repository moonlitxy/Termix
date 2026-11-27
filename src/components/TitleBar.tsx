import { useEffect, useRef, useState } from "react";
import {
  AVATAR_NAME_MAX,
  AVATARS,
  CUSTOM_AVATAR_ID,
  DEFAULT_AVATAR,
  DEFAULT_AVATAR_ID,
  getAvatar,
  isDefaultAvatar,
  loadAvatarId,
  loadAvatarNames,
  loadCustomAvatar,
  readAvatarFile,
  saveAvatarId,
  saveAvatarName,
  saveCustomAvatar,
} from "../lib/avatar";
import { getLang, useT, type Lang } from "../lib/i18n";
import { Icon } from "./Icon";
import { useApp } from "../store/app";
import { WindowControls } from "./WindowControls";
import { isWindowsPlatform, windowControls } from "../lib/windowControls";
import { appShortcutKey } from "../lib/shortcuts";
import { useUpdate } from "../store/update";
import { toast } from "../store/feedback";
import { ipc } from "../lib/ipc";
import { applyAppearance, loadSettings, saveSettings } from "../lib/settings";

export function TitleBar() {
  const t = useT();
  const activity = useApp((s) => s.activity);
  const setActivity = useApp((s) => s.setActivity);
  const openPalette = useApp((s) => s.openPalette);
  const checking = useUpdate((s) => s.checking);
  const updateInfo = useUpdate((s) => s.info);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [pickAvatarOpen, setPickAvatarOpen] = useState(false);
  const [avatarId, setAvatarId] = useState(loadAvatarId);
  const [avatarNames, setAvatarNames] = useState<Record<string, string>>(loadAvatarNames);
  const [customAvatar, setCustomAvatar] = useState(loadCustomAvatar);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [nameEditing, setNameEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [isWindows] = useState(isWindowsPlatform);
  const [curTheme, setCurTheme] = useState<"dark" | "light">(() => loadSettings().theme);
  const [curLang, setCurLang] = useState<Lang>(getLang);
  const searchShortcut = appShortcutKey("K");
  const selectedAvatar = getAvatar(avatarId);
  const avatar = selectedAvatar.id === CUSTOM_AVATAR_ID && customAvatar
    ? { ...selectedAvatar, src: customAvatar, name: t("avatar.custom"), bg: "#64748b" }
    : selectedAvatar;
  const avatarSrc = avatar.src;
  const avatarName = (id: string) => t(`avatar.${id}`);
  const defaultAvatarName =
    avatar.id === DEFAULT_AVATAR_ID ? t("avatar.defaultName") : avatarName(avatar.id);
  const displayAvatarName = avatarNames[avatar.id] ?? defaultAvatarName;

  useEffect(() => {
    setCurLang(getLang());
    setCurTheme(loadSettings().theme);
    if (!avatarOpen) {
      setPickAvatarOpen(false);
      setNameEditing(false);
    }
  }, [avatarOpen]);

  useEffect(() => {
    if (!nameEditing) return;
    nameInputRef.current?.focus();
    nameInputRef.current?.select();
  }, [nameEditing]);

  const pickAvatar = (id: string) => {
    setAvatarId(id);
    saveAvatarId(id);
    setNameEditing(false);
    setNameDraft("");
  };

  const toggleAvatarPicker = () => {
    setPickAvatarOpen((open) => !open);
  };

  const startEditAvatarName = () => {
    setNameDraft(displayAvatarName);
    setNameEditing(true);
  };

  const commitAvatarName = () => {
    const next = nameDraft.trim().slice(0, AVATAR_NAME_MAX);
    saveAvatarName(avatar.id, next);
    setAvatarNames((prev) => {
      const names = { ...prev };
      if (next) names[avatar.id] = next;
      else delete names[avatar.id];
      return names;
    });
    setNameEditing(false);
    setNameDraft("");
  };

  const cancelEditAvatarName = () => {
    setNameEditing(false);
    setNameDraft("");
  };

  const uploadAvatar = async (file: File | undefined) => {
    if (!file) return;
    try {
      const src = await readAvatarFile(file);
      saveCustomAvatar(src);
      setCustomAvatar(src);
      pickAvatar(CUSTOM_AVATAR_ID);
      setPickAvatarOpen(false);
      toast.success(t("avatar.uploadSuccess"));
    } catch (error) {
      toast.error(t("avatar.uploadFailed", { e: String(error) }));
    }
  };
  const handleSwitchTheme = (theme: "dark" | "light") => {
    const s = loadSettings();
    const next = { ...s, theme };
    setCurTheme(theme);
    saveSettings(next);
    applyAppearance(next);
  };

  const handleSwitchLang = (lang: Lang) => {
    setCurLang(lang);
    const s = loadSettings();
    saveSettings({ ...s, lang });
  };

  const handleCheckUpdate = async () => {
    const info = await useUpdate.getState().check();
    if (!info) {
      toast.error(t("st.updateCheckFailed"));
      return;
    }
    if (info.hasUpdate) {
      setAvatarOpen(false);
      useUpdate.getState().openDialog();
      return;
    }
    toast.success(t("st.updateLatest", { v: info.currentVersion }));
  };

  return (
    <div
      className={"titlebar" + (isWindows ? " titlebar--windows" : "")}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) void windowControls.startDragging();
      }}
      onDoubleClick={(e) => {
        if (e.target === e.currentTarget) void windowControls.toggleMaximize();
      }}
    >
      <WindowControls />
      <div className="titlebar__left">
        <span className="titlebar__brand">
          <span className="titlebar__brand-text">Termix</span>
        </span>
        <button
          className="titlebar__search"
          type="button"
          title={t("titlebar.searchTitle", { key: searchShortcut })}
          onClick={openPalette}
        >
          <Icon name="search" size={14} />
          <span>{t("titlebar.search")}</span>
          <span className="ds-kbd">{searchShortcut}</span>
        </button>
      </div>
      <div className="titlebar__right">
        <button
          className={
            "ds-btn ds-btn--tertiary ds-btn--icon" +
            (activity === "settings" ? " is-active" : "")
          }
          type="button"
          title={t("titlebar.settings")}
          onClick={() => setActivity("settings")}
        >
          <Icon name="settings" size={16} />
        </button>
        <div className="titlebar__avatar-wrap">
          <button
            className={
              "titlebar__avatar" + (avatarOpen ? " is-active" : "")
            }
            type="button"
            title={`${t("titlebar.userMenu")} (${displayAvatarName})`}
            aria-label={t("titlebar.userMenu")}
            style={{ background: avatar.bg }}
            onClick={() => setAvatarOpen((v) => !v)}
          >
            <img className="titlebar__avatar-img" src={avatarSrc} alt="" />
          </button>
          {avatarOpen && (
            <>
              <div
                className="titlebar__conn-backdrop"
                onClick={() => setAvatarOpen(false)}
              />
              <div className="ctx-menu titlebar__avatar-menu">
                <div className="titlebar__avatar-card">
                  <div
                    className="titlebar__avatar-badge"
                    style={{ background: avatar.bg }}
                    role="button"
                    tabIndex={0}
                    title={t("avatar.switchAvatar")}
                    aria-label={t("avatar.switchAvatar")}
                    onClick={toggleAvatarPicker}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        toggleAvatarPicker();
                      }
                    }}
                  >
                    <img src={avatarSrc} alt="" />
                  </div>
                  <div className="titlebar__avatar-meta-main">
                    <div className="titlebar__avatar-name-row">
                      {nameEditing ? (
                        <input
                          ref={nameInputRef}
                          className="titlebar__avatar-name-input"
                          value={nameDraft}
                          maxLength={AVATAR_NAME_MAX}
                          aria-label={t("avatar.editName")}
                          onChange={(event) => setNameDraft(event.target.value)}
                          onBlur={commitAvatarName}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              commitAvatarName();
                            } else if (event.key === "Escape") {
                              event.preventDefault();
                              cancelEditAvatarName();
                            }
                          }}
                        />
                      ) : (
                        <button
                          type="button"
                          className="titlebar__avatar-name"
                          title={t("avatar.editName")}
                          onClick={startEditAvatarName}
                        >
                          <span>{displayAvatarName}</span>
                          <Icon name="edit" size={11} />
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {pickAvatarOpen && (
                  <div className="titlebar__avatar-picker-wrap">
                    <div className="titlebar__avatar-grid">
                      <button
                        type="button"
                        className={
                          "titlebar__avatar-pick titlebar__avatar-pick--default" +
                          (isDefaultAvatar(avatarId) ? " is-active" : "")
                        }
                        title={t("avatar.default")}
                        aria-label={t("avatar.default")}
                        onClick={() => pickAvatar(DEFAULT_AVATAR_ID)}
                      >
                        <img src={DEFAULT_AVATAR.src} alt="" />
                      </button>
                      {AVATARS.map((a) => (
                        <button
                          key={a.id}
                          type="button"
                          className={
                            "titlebar__avatar-pick" + (a.id === avatarId ? " is-active" : "")
                          }
                          title={avatarName(a.id)}
                          style={{ background: a.bg }}
                          onClick={() => pickAvatar(a.id)}
                        >
                          <img src={a.src} alt="" />
                        </button>
                      ))}
                    </div>
                    <input
                      ref={avatarInputRef}
                      className="titlebar__avatar-file"
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif"
                      onChange={(event) => {
                        void uploadAvatar(event.target.files?.[0]);
                        event.target.value = "";
                      }}
                    />
                    <button
                      type="button"
                      className="ctx-menu__item titlebar__avatar-upload"
                      onClick={() => avatarInputRef.current?.click()}
                    >
                      <Icon name="upload" size={13} />
                      {t("avatar.upload")}
                    </button>
                  </div>
                )}

                <div className="ctx-menu__sep" />

                <div className="titlebar__menu-row">
                  <span className="titlebar__menu-row-label">
                    <Icon name="eye" size={12} />
                    {t("avatar.theme")}
                  </span>
                  <div className="st-seg titlebar__menu-seg">
                    {(["dark", "light"] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        className={"st-seg__btn" + (curTheme === m ? " is-active" : "")}
                        onClick={() => handleSwitchTheme(m)}
                      >
                        {m === "dark" ? t("st.theme.dark") : t("st.theme.light")}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="titlebar__menu-row">
                  <span className="titlebar__menu-row-label">
                    <Icon name="settings" size={12} />
                    {t("avatar.language")}
                  </span>
                  <div className="st-seg titlebar__menu-seg">
                    <button
                      type="button"
                      className={"st-seg__btn" + (curLang === "zh" ? " is-active" : "")}
                      onClick={() => handleSwitchLang("zh")}
                    >
                      中文
                    </button>
                    <button
                      type="button"
                      className={"st-seg__btn" + (curLang === "en" ? " is-active" : "")}
                      onClick={() => handleSwitchLang("en")}
                    >
                      EN
                    </button>
                  </div>
                </div>

                <div className="ctx-menu__sep" />

                <button
                  type="button"
                  className="ctx-menu__item"
                  disabled={checking}
                  onClick={() => void handleCheckUpdate()}
                >
                  <Icon name="refresh" size={12} />
                  <span>{checking ? t("st.checking") : updateInfo?.hasUpdate ? "发现新版本" : t("st.check")}</span>
                  <span className="titlebar__menu-tag">
                    {updateInfo?.hasUpdate ? `v${updateInfo.latestVersion}` : `v${__TERMIX_VERSION__}`}
                  </span>
                </button>
                <button
                  type="button"
                  className="ctx-menu__item"
                  onClick={() => {
                    setAvatarOpen(false);
                    useApp.getState().setHelpAnchor(null);
                    setActivity("help");
                  }}
                >
                  <Icon name="help" size={12} />
                  <span>{t("rail.help")}</span>
                </button>
                <button
                  type="button"
                  className="ctx-menu__item"
                  onClick={() => {
                    setAvatarOpen(false);
                    void ipc.openExternal("https://github.com/moonlitxy/Termix").catch(() => {});
                  }}
                >
                  <Icon name="terminal" size={12} />
                  <span>{t("avatar.community")}</span>
                  <Icon name="chevron-right" size={11} className="titlebar__menu-arrow" />
                </button>
                <button
                  type="button"
                  className="ctx-menu__item"
                  onClick={() => {
                    setAvatarOpen(false);
                    void ipc.openExternal("https://github.com/moonlitxy/Termix/issues").catch(() => {});
                  }}
                >
                  <Icon name="alert-circle" size={12} />
                  <span>{t("avatar.reportIssue")}</span>
                  <Icon name="chevron-right" size={11} className="titlebar__menu-arrow" />
                </button>

                <div className="ctx-menu__sep" />

                <button
                  type="button"
                  className="ctx-menu__item titlebar__menu-exit"
                  onClick={() => void windowControls.close()}
                >
                  <Icon name="x-circle" size={12} />
                  <span>{t("avatar.quitApp")}</span>
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
