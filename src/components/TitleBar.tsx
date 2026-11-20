import { useEffect, useState } from "react";
import { AVATARS, getAvatar, loadAvatarId, randomAvatarId, saveAvatarId } from "../lib/avatar";
import { getLang, useT, type Lang } from "../lib/i18n";
import { Icon } from "./Icon";
import { useApp } from "../store/app";
import { WindowControls } from "./WindowControls";
import { isWindowsPlatform, windowControls } from "../lib/windowControls";
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
  const [isWindows] = useState(isWindowsPlatform);
  const [curTheme, setCurTheme] = useState<"dark" | "light">(() => loadSettings().theme);
  const [curLang, setCurLang] = useState<Lang>(getLang);
  const shortcutMod = isWindows ? "Ctrl" : "⌘";
  const avatar = getAvatar(avatarId);

  useEffect(() => {
    setCurLang(getLang());
    setCurTheme(loadSettings().theme);
  }, [avatarOpen]);

  const pickAvatar = (id: string) => {
    setAvatarId(id);
    saveAvatarId(id);
  };
  const avatarName = (id: string) => t(`avatar.${id}`);

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
          <span className="titlebar__brand-mark">
            <Icon name="terminal" size={13} />
          </span>
          <span className="titlebar__brand-text">Termix</span>
        </span>
        <button
          className="titlebar__search"
          type="button"
          title={t("titlebar.searchTitle", { mod: shortcutMod })}
          onClick={openPalette}
        >
          <Icon name="search" size={14} />
          <span>{t("titlebar.search")}</span>
          <span className="ds-kbd">{shortcutMod}K</span>
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
            title={`${t("titlebar.userMenu")} (${avatarName(avatar.id)})`}
            aria-label={t("titlebar.userMenu")}
            style={{ background: avatar.bg }}
            onClick={() => setAvatarOpen((v) => !v)}
          >
            <img className="titlebar__avatar-img" src={avatar.src} alt="" />
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
                  >
                    <img src={avatar.src} alt="" />
                  </div>
                  <div className="titlebar__avatar-meta-main">
                    <div className="titlebar__avatar-name-row">
                      <span className="titlebar__avatar-name">{avatarName(avatar.id)}</span>
                    </div>
                    <div className="titlebar__avatar-sub">
                      <Icon name="sparkles" size={11} />
                      <span>v{__TERMIX_VERSION__}</span>
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  className="ctx-menu__item titlebar__avatar-toggle"
                  onClick={() => setPickAvatarOpen((v) => !v)}
                >
                  <Icon name="sparkles" size={12} />
                  <span>{t("avatar.switchAvatar")}</span>
                  <Icon name={pickAvatarOpen ? "chevron-up" : "chevron-down"} size={11} />
                </button>

                {pickAvatarOpen && (
                  <div className="titlebar__avatar-picker-wrap">
                    <div className="titlebar__avatar-grid">
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
                    <button
                      type="button"
                      className="ctx-menu__item"
                      title={t("avatar.randomTitle")}
                      onClick={() => pickAvatar(randomAvatarId(avatarId))}
                    >
                      <Icon name="sparkles" size={12} />
                      {t("avatar.random")}
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
