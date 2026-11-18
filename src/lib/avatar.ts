/**
 * 本地默认头像（趣味性）。
 *
 * 狗狗与鲸鱼为首批主打，其余小动物/机器人用于空状态与随机切换，
 * 全部为 emoji + 背景色本地渲染，无需新增图片资源与网络请求。
 */

export interface Avatar {
  id: string;
  name: string;
  emoji: string;
  bg: string;
}

export const AVATARS: Avatar[] = [
  { id: "dog", name: "柴犬", emoji: "🐶", bg: "#f6c177" },
  { id: "whale", name: "鲸鱼娘", emoji: "🐳", bg: "#7aa2f7" },
  { id: "fox", name: "狐狸", emoji: "🦊", bg: "#ff9e64" },
  { id: "cat", name: "橘猫", emoji: "🐱", bg: "#ffcf7a" },
  { id: "penguin", name: "企鹅", emoji: "🐧", bg: "#9eceff" },
  { id: "robot", name: "机器人", emoji: "🤖", bg: "#9ece6a" },
];

export const AVATAR_KEY = "termix.avatarId";
const DEFAULT_AVATAR_ID = "dog";

export function getAvatar(id: string | null | undefined): Avatar {
  return AVATARS.find((a) => a.id === id) ?? AVATARS[0];
}

export function loadAvatarId(): string {
  try {
    const raw = localStorage.getItem(AVATAR_KEY);
    if (raw && AVATARS.some((a) => a.id === raw)) return raw;
  } catch {
    /* ignore */
  }
  return DEFAULT_AVATAR_ID;
}

export function saveAvatarId(id: string): void {
  try {
    if (AVATARS.some((a) => a.id === id)) localStorage.setItem(AVATAR_KEY, id);
  } catch {
    /* ignore */
  }
}

/** 随机挑一个与当前不同的头像，用于“一键换心情”。 */
export function randomAvatarId(excludeId?: string): string {
  const pool = AVATARS.filter((a) => a.id !== excludeId);
  const list = pool.length > 0 ? pool : AVATARS;
  return list[Math.floor(Math.random() * list.length)].id;
}
