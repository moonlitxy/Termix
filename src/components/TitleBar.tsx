import { Icon } from "./Icon";
import { useApp } from "../store/app";

export function TitleBar() {
  const searchKeyword = useApp((s) => s.searchKeyword);
  const setSearch = useApp((s) => s.setSearch);

  return (
    <div className="titlebar">
      <div className="titlebar__left">
        <div className="titlebar__traffic">
          <span className="titlebar__traffic-light titlebar__traffic-light--close" />
          <span className="titlebar__traffic-light titlebar__traffic-light--min" />
          <span className="titlebar__traffic-light titlebar__traffic-light--max" />
        </div>
        <span className="titlebar__brand">
          <Icon name="terminal" size={14} />
          Termix
        </span>
        <button className="titlebar__conn-select" type="button">
          <Icon name="plug" size={14} />
          生产服务器 · Aliyun
          <Icon name="chevron-down" size={12} />
        </button>
        <div className="ds-input titlebar__search">
          <span className="ds-input__icon">
            <Icon name="search" size={14} />
          </span>
          <input
            type="text"
            placeholder="搜索会话 / 命令 / 文件"
            value={searchKeyword}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>
      <div className="titlebar__right">
        <span className="titlebar__pro-tag">
          <Icon name="sparkles" size={12} />
          免费
        </span>
        <button className="ds-btn ds-btn--tertiary ds-btn--icon" type="button" title="设置">
          <Icon name="settings" size={16} />
        </button>
        <button className="ds-btn ds-btn--tertiary ds-btn--icon" type="button" title="通知">
          <Icon name="bell" size={16} />
        </button>
        <span className="titlebar__avatar">D</span>
      </div>
    </div>
  );
}
