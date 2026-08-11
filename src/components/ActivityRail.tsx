import { Icon } from "./Icon";
import { useApp } from "../store/app";
import type { Activity } from "../types";

interface RailItem {
  id: Activity;
  icon: string;
  label: string;
}

const ITEMS: RailItem[] = [
  { id: "terminal", icon: "terminal", label: "终端会话" },
  { id: "sftp", icon: "folder", label: "SFTP" },
  { id: "forward", icon: "arrow-right-to-line", label: "端口转发" },
  { id: "snippets", icon: "scroll-text", label: "命令片段" },
  { id: "monitor", icon: "bar", label: "监控" },
];

const BOTTOM_ITEMS: RailItem[] = [
  { id: "settings", icon: "settings", label: "设置" },
  { id: "plugins", icon: "grid-2x2", label: "插件" },
  { id: "help", icon: "help", label: "帮助" },
];

export function ActivityRail() {
  const activity = useApp((s) => s.activity);
  const setActivity = useApp((s) => s.setActivity);

  return (
    <div className="activity-rail">
      {ITEMS.map((item) => (
        <button
          key={item.id}
          type="button"
          className={
            "activity-rail__btn" + (activity === item.id ? " is-active" : "")
          }
          title={item.label}
          onClick={() => setActivity(item.id)}
        >
          <Icon name={item.icon} size={18} />
        </button>
      ))}
      <div className="activity-rail__spacer" />
      {BOTTOM_ITEMS.map((item) => (
        <button
          key={item.id}
          type="button"
          className={
            "activity-rail__btn" + (activity === item.id ? " is-active" : "")
          }
          title={item.label}
          onClick={() => setActivity(item.id)}
        >
          <Icon name={item.icon} size={18} />
        </button>
      ))}
    </div>
  );
}
