import { useState } from "react";
import { AVATARS, getAvatar, loadAvatarId, randomAvatarId, saveAvatarId } from "../lib/avatar";
import { pickFunLocalized } from "../lib/fun";
import { getLang, useT } from "../lib/i18n";
import { Icon } from "./Icon";
import { useApp } from "../store/app";
import { WindowControls } from "./WindowControls";
import { isWindowsPlatform, windowControls } from "../lib/windowControls";

export function TitleBar() {
  const t = useT();
  const activity = useApp((s) => s.activity);
  const setActivity = useApp((s) => s.setActivity);
  const openPalette = useApp((s) => s.openPalette);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [avatarId, setAvatarId] = useState(loadAvatarId);
  const [isWindows] = useState(isWindowsPlatform);
  const shortcutMod = isWindows ? "Ctrl" : "⌘";
  const avatar = getAvatar(avatarId);
  const pickAvatar = (id: string) => {
    setAvatarId(id);
    saveAvatarId(id);
  };
  const avatarName = (id: string) => t(`avatar.${id}`);

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
            <span className="titlebar__avatar-emoji" aria-hidden="true">
              {avatar.emoji}
            </span>
          </button>
          {avatarOpen && (
            <>
              <div
                className="titlebar__conn-backdrop"
                onClick={() => setAvatarOpen(false)}
              />
              <div className="ctx-menu titlebar__avatar-menu">
                <div className="titlebar__avatar-info">
                  <div className="titlebar__avatar-name">
                    {avatar.emoji} {avatarName(avatar.id)}
                  </div>
                  <div className="titlebar__avatar-meta">
                    {pickFunLocalized("avatarTips", avatarId.length, getLang())}
                  </div>
                </div>
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
                      <span aria-hidden="true">{a.emoji}</span>
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
                <div className="ctx-menu__sep" />
                <button
                  type="button"
                  className="ctx-menu__item"
                  title={t("titlebar.prefs")}
                  onClick={() => {
                    setAvatarOpen(false);
                    setActivity("settings");
                  }}
                >
                  <Icon name="settings" size={12} />
                  {t("titlebar.prefs")}
                </button>
                <button
                  type="button"
                  className="ctx-menu__item"
                  title={t("titlebar.help")}
                  onClick={() => {
                    setAvatarOpen(false);
                    setActivity("help");
                  }}
                >
                  <Icon name="help" size={12} />
                  {t("titlebar.help")}
                </button>
                <button
                  type="button"
                  className="ctx-menu__item"
                  title={t("titlebar.about")}
                  onClick={() => {
                    setAvatarOpen(false);
                    // 进入帮助页并定位到「关于 Termix」区块（版本号由构建配置注入，避免硬编码）
                    useApp.getState().setHelpAnchor("about");
                    setActivity("help");
                  }}
                >
                  <Icon name="info-circle" size={12} />
                  {t("titlebar.about")}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
