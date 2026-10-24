import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { windowControls } from "../lib/windowControls";

function controlPlatform(): "macos" | "windows" {
  return navigator.userAgent.includes("Windows") ? "windows" : "macos";
}

/** 自绘窗口控制：macOS 左侧三点、Windows 右侧三键，风格与暗色标题栏统一 */
export function WindowControls() {
  const [platform] = useState(controlPlatform);
  const [, setMaximized] = useState(false);

  useEffect(() => {
    void windowControls.isMaximized().then(setMaximized).catch(() => {});
    const promise = getCurrentWindow().onResized(() => {
      void windowControls.isMaximized().then(setMaximized).catch(() => {});
    });
    return () => {
      void promise.then((unlisten) => unlisten());
    };
  }, []);

  if (platform === "macos") {
    return (
      <div className="window-controls window-controls--macos" aria-label="窗口控制">
        <button
          className="window-controls__dot window-controls__dot--close"
          type="button"
          title="关闭窗口"
          aria-label="关闭窗口"
          onClick={() => void windowControls.close()}
          onDoubleClick={(e) => e.stopPropagation()}
        />
        <button
          className="window-controls__dot window-controls__dot--minimize"
          type="button"
          title="最小化窗口"
          aria-label="最小化窗口"
          onClick={() => void windowControls.minimize()}
          onDoubleClick={(e) => e.stopPropagation()}
        />
        <button
          className="window-controls__dot window-controls__dot--maximize"
          type="button"
          title="缩放窗口"
          aria-label="缩放窗口"
          onClick={() => void windowControls.toggleMaximize()}
          onDoubleClick={(e) => e.stopPropagation()}
        />
      </div>
    );
  }

  return (
    <div className="window-controls window-controls--windows" aria-label="窗口控制">
      <button
        className="window-controls__square window-controls__square--minimize"
        type="button"
        title="最小化"
        aria-label="最小化窗口"
        onClick={() => void windowControls.minimize()}
          onDoubleClick={(e) => e.stopPropagation()}
      />
      <button
        className="window-controls__square window-controls__square--maximize"
        type="button"
        title="最大化"
        aria-label="最大化或还原窗口"
          onClick={() => void windowControls.toggleMaximize()}
          onDoubleClick={(e) => e.stopPropagation()}
      />
      <button
        className="window-controls__square window-controls__square--close"
        type="button"
        title="关闭"
        aria-label="关闭窗口"
        onClick={() => void windowControls.close()}
          onDoubleClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}
