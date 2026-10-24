import { useState } from "react";
import { Icon } from "./Icon";
import { useApp } from "../store/app";

export function TitleBar() {
  const activity = useApp((s) => s.activity);
  const setActivity = useApp((s) => s.setActivity);
  const openPalette = useApp((s) => s.openPalette);
  const [avatarOpen, setAvatarOpen] = useState(false);

  return (
    <div className="titlebar">
      <div className="titlebar__left">
        <span className="titlebar__brand">
          <Icon name="terminal" size={14} />
          Termix
        </span>
        <button
          className="titlebar__search"
          type="button"
          title="全局搜索（⌘K）"
          onClick={openPalette}
        >
          <Icon name="search" size={14} />
          <span>搜索</span>
          <span className="ds-kbd">⌘K</span>
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
            onClick={() => setAvatarOpen((v) => !v)}
          >
            <Icon name="user" size={14} />
          </button>
          {avatarOpen && (
            <>
              <div
                className="titlebar__conn-backdrop"
                onClick={() => setAvatarOpen(false)}
              />
              <div className="ctx-menu titlebar__avatar-menu">
                <div className="titlebar__avatar-info">
                  <div className="titlebar__avatar-name">Termix 本地用户</div>
                  <div className="titlebar__avatar-meta">
                    连接配置与偏好保存在本机
                  </div>
                </div>
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
