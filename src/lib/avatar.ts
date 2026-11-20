/**
 * 本地默认头像。
 *
 * 使用内置二次元插画头像，避免运行时网络请求；素材来源与授权说明见
 * `src/assets/avatars/README.md`。
 */

import azureAvatar from "../assets/avatars/azure.webp";
import chestnutAvatar from "../assets/avatars/chestnut.webp";
import mintAvatar from "../assets/avatars/mint.webp";
import shionAvatar from "../assets/avatars/shion.webp";
import yukinoAvatar from "../assets/avatars/yukino.webp";

export interface Avatar {
  id: string;
  name: string;
  src: string;
  bg: string;
}

export const AVATARS: Avatar[] = [
  { id: "mint", name: "薄荷", src: mintAvatar, bg: "#c7e7d8" },
  { id: "azure", name: "苍", src: azureAvatar, bg: "#c9ddf6" },
  { id: "chestnut", name: "栗子", src: chestnutAvatar, bg: "#ead3bd" },
  { id: "yukino", name: "雪乃", src: yukinoAvatar, bg: "#e6e2f3" },
  { id: "shion", name: "紫苑", src: shionAvatar, bg: "#e2d5f0" },
];

export const AVATAR_KEY = "termix.avatarId";
const DEFAULT_AVATAR_ID = "mint";

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
