import { getCurrentWindow } from "@tauri-apps/api/window";

export const windowControls = {
  minimize: () => getCurrentWindow().minimize(),
  toggleMaximize: () => getCurrentWindow().toggleMaximize(),
  close: () => getCurrentWindow().close(),
  startDragging: () => getCurrentWindow().startDragging(),
  isMaximized: () => getCurrentWindow().isMaximized(),
};
