export function StatusBar() {
  return (
    <div className="status-bar">
      <div className="status-bar__left">
        <span className="status-bar__item">
          <span className="ds-dot ds-dot--success" />
          已连接
        </span>
        <span className="status-bar__item">UTF-8</span>
        <span className="status-bar__item">SSH-2</span>
      </div>
      <div className="status-bar__right">
        <span className="status-bar__shortcut">
          终端 <span className="ds-kbd">⌘T</span> 新建会话
        </span>
        <span className="status-bar__shortcut">
          断开 <span className="ds-kbd">⌘D</span>
        </span>
      </div>
    </div>
  );
}
