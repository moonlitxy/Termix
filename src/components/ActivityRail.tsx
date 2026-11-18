import { Icon } from "./Icon";
import { useApp } from "../store/app";
import { useT } from "../lib/i18n";
import type { Activity } from "../types";

interface RailItem {
  id: Activity;
  icon: string;
  labelKey: string;
}

const ITEMS: RailItem[] = [
  { id: "terminal", icon: "terminal", labelKey: "rail.terminal" },
  { id: "forward", icon: "arrow-right-to-line", labelKey: "rail.forward" },
  { id: "snippets", icon: "scroll-text", labelKey: "rail.snippets" },
  { id: "monitor", icon: "bar", labelKey: "rail.monitor" },
];

const BOTTOM_ITEMS: RailItem[] = [
  { id: "settings", icon: "settings", labelKey: "rail.settings" },
  { id: "help", icon: "help", labelKey: "rail.help" },
];

export function ActivityRail() {
  const t = useT();
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
          title={t(item.labelKey)}
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
          title={t(item.labelKey)}
          onClick={() => setActivity(item.id)}
        >
          <Icon name={item.icon} size={18} />
        </button>
      ))}
    </div>
  );
}
