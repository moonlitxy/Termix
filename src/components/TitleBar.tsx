import { useState } from "react";
import { AVATARS, getAvatar, loadAvatarId, randomAvatarId, saveAvatarId } from "../lib/avatar";
import { FUN_AVATAR_TIPS, pickFun } from "../lib/fun";
import { Icon } from "./Icon";
import { useApp } from "../store/app";
import { WindowControls } from "./WindowControls";
import { isWindowsPlatform, windowControls } from "../lib/windowControls";

export function TitleBar() {
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
          title={`全局搜索（${shortcutMod}+K）`}
          onClick={openPalette}
        >
          <Icon name="search" size={14} />
          <span>搜索</span>
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
          title="设置"
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
            title="用户菜单"
            aria-label="用户菜单"
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
                    {avatar.emoji} {avatar.name}
                  </div>
                  <div className="titlebar__avatar-meta">
                    {pickFun(FUN_AVATAR_TIPS, avatarId.length)}
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
                      title={`切换为${a.name}`}
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
                  title="随机换一个头像"
                  onClick={() => pickAvatar(randomAvatarId(avatarId))}
                >
                  <Icon name="sparkles" size={12} />
                  随机换一个
                </button>
                <div className="ctx-menu__sep" />
                <button
                  type="button"
                  className="ctx-menu__item"
                  title="打开系统偏好设置"
                  onClick={() => {
                    setAvatarOpen(false);
                    setActivity("settings");
                  }}
                >
                  <Icon name="settings" size={12} />
                  系统偏好设置
                </button>
                <button
                  type="button"
                  className="ctx-menu__item"
                  title="查看帮助与文档"
                  onClick={() => {
                    setAvatarOpen(false);
                    setActivity("help");
                  }}
                >
                  <Icon name="help" size={12} />
                  帮助与文档
                </button>
                <button
                  type="button"
                  className="ctx-menu__item"
                  title="查看 Termix 版本信息"
                  onClick={() => {
                    setAvatarOpen(false);
                    // 进入帮助页并定位到「关于 Termix」区块（版本号由构建配置注入，避免硬编码）
                    useApp.getState().setHelpAnchor("about");
                    setActivity("help");
                  }}
                >
                  <Icon name="info-circle" size={12} />
                  关于 Termix
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
