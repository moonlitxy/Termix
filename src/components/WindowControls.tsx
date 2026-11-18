import { useT } from "../lib/i18n";
import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isWindowsPlatform, windowControls } from "../lib/windowControls";

/** 自绘窗口控制：macOS 左侧三点、Windows 右侧三键，风格与暗色标题栏统一 */
export function WindowControls() {
  const t = useT();
  const [platform] = useState(() =>
    isWindowsPlatform() ? "windows" : "macos"
  );
  const [, setMaximized] = useState(false);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let cancelled = false;
    void windowControls.isMaximized()
      .then((value) => { if (!cancelled) setMaximized(value); })
      .catch(() => {});
    const promise = getCurrentWindow()
      .onResized(() => {
        void windowControls.isMaximized()
          .then((value) => { if (!cancelled) setMaximized(value); })
          .catch(() => {});
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      void promise.then((unlisten) => unlisten?.());
    };
  }, []);

  if (platform === "macos") {
    return (
      <div className="window-controls window-controls--macos" aria-label={t("win.controls")}>
        <button
          className="window-controls__dot window-controls__dot--close"
          type="button"
          title={t("win.close")}
          aria-label={t("win.close")}
          onClick={() => void windowControls.close()}
          onDoubleClick={(e) => e.stopPropagation()}
        />
        <button
          className="window-controls__dot window-controls__dot--minimize"
          type="button"
          title={t("win.min")}
          aria-label={t("win.min")}
          onClick={() => void windowControls.minimize()}
          onDoubleClick={(e) => e.stopPropagation()}
        />
        <button
          className="window-controls__dot window-controls__dot--maximize"
          type="button"
          title={t("win.zoom")}
          aria-label={t("win.zoom")}
          onClick={() => void windowControls.toggleMaximize()}
          onDoubleClick={(e) => e.stopPropagation()}
        />
      </div>
    );
  }

  return (
    <div className="window-controls window-controls--windows" aria-label={t("win.controls")}>
      <button
        className="window-controls__square window-controls__square--minimize"
        type="button"
        title={t("win.minShort")}
        aria-label={t("win.min")}
        onClick={() => void windowControls.minimize()}
          onDoubleClick={(e) => e.stopPropagation()}
      />
      <button
        className="window-controls__square window-controls__square--maximize"
        type="button"
        title={t("win.max")}
        aria-label={t("win.maxToggle")}
          onClick={() => void windowControls.toggleMaximize()}
          onDoubleClick={(e) => e.stopPropagation()}
      />
      <button
        className="window-controls__square window-controls__square--close"
        type="button"
        title={t("common.close")}
        aria-label={t("win.close")}
        onClick={() => void windowControls.close()}
          onDoubleClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}
