import alertCircle from "../assets/icons/alert-circle.svg?raw";
import arrowExpand from "../assets/icons/arrow-expand.svg?raw";
import arrowRightToLine from "../assets/icons/arrow-right-to-line.svg?raw";
import arrowUp from "../assets/icons/arrow-up.svg?raw";
import bar from "../assets/icons/bar.svg?raw";
import bell from "../assets/icons/bell.svg?raw";
import chevronDown from "../assets/icons/chevron-down.svg?raw";
import chevronRight from "../assets/icons/chevron-right.svg?raw";
import clock from "../assets/icons/clock.svg?raw";
import columns from "../assets/icons/columns.svg?raw";
import copy from "../assets/icons/copy.svg?raw";
import cpu from "../assets/icons/cpu.svg?raw";
import download from "../assets/icons/download.svg?raw";
import edit from "../assets/icons/edit.svg?raw";
import eye from "../assets/icons/eye.svg?raw";
import eyeOff from "../assets/icons/eye-off.svg?raw";
import file from "../assets/icons/file.svg?raw";
import folder from "../assets/icons/folder.svg?raw";
import grid2x2 from "../assets/icons/grid-2x2.svg?raw";
import help from "../assets/icons/help.svg?raw";
import key from "../assets/icons/key.svg?raw";
import logo from "../assets/icons/logo.svg?raw";
import moreH from "../assets/icons/more-h.svg?raw";
import pause from "../assets/icons/pause.svg?raw";
import play from "../assets/icons/play.svg?raw";
import plug from "../assets/icons/plug.svg?raw";
import plus from "../assets/icons/plus.svg?raw";
import refresh from "../assets/icons/refresh.svg?raw";
import scrollText from "../assets/icons/scroll-text.svg?raw";
import search from "../assets/icons/search.svg?raw";
import send from "../assets/icons/send.svg?raw";
import settings from "../assets/icons/settings.svg?raw";
import sparkles from "../assets/icons/sparkles.svg?raw";
import terminalSvg from "../assets/icons/terminal.svg?raw";
import trash from "../assets/icons/trash.svg?raw";
import upload from "../assets/icons/upload.svg?raw";
import x from "../assets/icons/x.svg?raw";
import xCircle from "../assets/icons/x-circle.svg?raw";

const ICONS: Record<string, string> = {
  "alert-circle": alertCircle,
  "arrow-expand": arrowExpand,
  "arrow-right-to-line": arrowRightToLine,
  "arrow-up": arrowUp,
  bar,
  bell,
  "chevron-down": chevronDown,
  "chevron-right": chevronRight,
  clock,
  columns,
  copy,
  cpu,
  download,
  edit,
  eye,
  "eye-off": eyeOff,
  file,
  folder,
  "grid-2x2": grid2x2,
  help,
  key,
  logo,
  "more-h": moreH,
  pause,
  play,
  plug,
  plus,
  refresh,
  "scroll-text": scrollText,
  search,
  send,
  settings,
  sparkles,
  terminal: terminalSvg,
  trash,
  upload,
  x,
  "x-circle": xCircle,
};

export function Icon({
  name,
  size = 14,
  className,
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  const svg = ICONS[name];
  if (!svg) return null;
  return (
    <span
      className={"icon " + (className || "")}
      style={{ width: size, height: size }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
