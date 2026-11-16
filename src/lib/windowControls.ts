import { getCurrentWindow } from "@tauri-apps/api/window";

export function isWindowsPlatform(): boolean {
  return (
    typeof navigator !== "undefined" &&
    navigator.userAgent.includes("Windows")
  );
}

export const windowControls = {
  minimize: () => getCurrentWindow().minimize(),
  toggleMaximize: () => getCurrentWindow().toggleMaximize(),
  close: () => getCurrentWindow().close(),
  startDragging: () => getCurrentWindow().startDragging(),
  isMaximized: () => getCurrentWindow().isMaximized(),
};
