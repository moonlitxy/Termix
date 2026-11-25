import { useApp } from "../store/app";
import { findLastCdCommand } from "./cdPath";

const timers = new Map<string, number>();

/** 终端写入命令后调度一次 cwd 同步；只处理可解析的 cd/pushd。 */
export function scheduleRemoteCwdSync(
  text: string,
  connectionId: string,
  shellId: string
) {
  const command = findLastCdCommand(text);
  if (!command) return;
  console.debug("[cwd] schedule", command, { connectionId, shellId });
  const previous = timers.get(shellId);
  if (previous !== undefined) window.clearTimeout(previous);
  const timer = window.setTimeout(() => {
    timers.delete(shellId);
    void useApp.getState().syncRemoteCwd(command, connectionId, shellId);
  }, 120);
  timers.set(shellId, timer);
}
