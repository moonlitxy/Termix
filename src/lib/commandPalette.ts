import type { Activity } from "../types";

export type PaletteItemKind = "session" | "snippet" | "history" | "activity";

export interface PaletteSourceItem {
  id: string;
  title: string;
  subtitle?: string;
  keywords?: string[];
}

export interface PaletteItem extends PaletteSourceItem {
  kind: PaletteItemKind;
  score: number;
}

const KIND_WEIGHT: Record<PaletteItemKind, number> = {
  session: 0,
  snippet: 1,
  history: 2,
  activity: 3,
};

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export function searchPalette<T extends PaletteSourceItem>(
  query: string,
  kind: PaletteItemKind,
  items: T[]
): PaletteItem[] {
  const q = normalize(query);
  const matched = items.map((item) => {
    const title = normalize(item.title);
    const subtitle = normalize(item.subtitle ?? "");
    const keywords = item.keywords?.map(normalize) ?? [];
    let score = Number.MAX_SAFE_INTEGER;
    if (!q) {
      score = 100;
    } else if (title.startsWith(q)) {
      score = title === q ? 0 : 1;
    } else if (title.includes(q)) {
      score = 10;
    } else if (subtitle.includes(q) || keywords.some((k) => k.includes(q))) {
      score = 20;
    }
    return { ...item, kind, score };
  });
  return matched
    .filter((item) => item.score !== Number.MAX_SAFE_INTEGER)
    .sort((a, b) =>
      a.score - b.score ||
      KIND_WEIGHT[a.kind] - KIND_WEIGHT[b.kind] ||
      a.title.localeCompare(b.title, "zh-Hans-CN")
    )
    .slice(0, 12);
}

export const PALETTE_ACTIVITIES: {
  id: Activity;
  title: string;
  subtitle: string;
}[] = [
  { id: "terminal", title: "终端会话", subtitle: "切换到终端与文件面板" },
  { id: "forward", title: "端口转发", subtitle: "管理本地、远程和动态转发" },
  { id: "snippets", title: "命令片段", subtitle: "管理和执行常用命令" },
  { id: "monitor", title: "系统监控", subtitle: "查看远程服务器资源占用" },
  { id: "settings", title: "设置", subtitle: "主题、终端、安全和更新" },
  { id: "help", title: "帮助", subtitle: "快捷键和常见问题" },
];
