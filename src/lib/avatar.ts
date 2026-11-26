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
import defaultAvatar from "../assets/avatars/default.svg";

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
export const CUSTOM_AVATAR_KEY = "termix.customAvatar";
export const CUSTOM_AVATAR_ID = "custom";
export const DEFAULT_AVATAR_ID = "default";

export const DEFAULT_AVATAR: Avatar = {
  id: DEFAULT_AVATAR_ID,
  name: "默认头像",
  src: defaultAvatar,
  bg: "#64748b",
};

export function getAvatar(id: string | null | undefined): Avatar {
  if (id === DEFAULT_AVATAR_ID) return DEFAULT_AVATAR;
  return AVATARS.find((a) => a.id === id) ?? DEFAULT_AVATAR;
}

export function isDefaultAvatar(id: string | null | undefined): boolean {
  return getAvatar(id).id === DEFAULT_AVATAR_ID;
}

export function loadAvatarId(): string {
  try {
    const raw = localStorage.getItem(AVATAR_KEY);
    if (
      raw !== null &&
      (raw === DEFAULT_AVATAR_ID || raw === CUSTOM_AVATAR_ID || AVATARS.some((a) => a.id === raw))
    ) {
      return raw;
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_AVATAR_ID;
}

export function saveAvatarId(id: string): void {
  try {
    if (
      id === DEFAULT_AVATAR_ID ||
      id === CUSTOM_AVATAR_ID ||
      AVATARS.some((a) => a.id === id)
    ) {
      localStorage.setItem(AVATAR_KEY, id);
    }
  } catch {
    /* ignore */
  }
}

export function loadCustomAvatar(): string {
  try {
    return localStorage.getItem(CUSTOM_AVATAR_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveCustomAvatar(src: string): void {
  try {
    if (src) localStorage.setItem(CUSTOM_AVATAR_KEY, src);
  } catch {
    /* ignore */
  }
}

export function validateAvatarFile(file: File): string | null {
  if (!file.type.startsWith("image/")) return "请选择图片文件";
  if (file.size > 8 * 1024 * 1024) return "图片不能超过 8 MB";
  return null;
}

export async function readAvatarFile(file: File): Promise<string> {
  const error = validateAvatarFile(file);
  if (error) throw new Error(error);
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error("图片解析失败"));
    element.src = dataUrl;
  });
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("图片处理失败");
  const crop = Math.min(image.naturalWidth, image.naturalHeight);
  const sx = (image.naturalWidth - crop) / 2;
  const sy = (image.naturalHeight - crop) / 2;
  context.drawImage(image, sx, sy, crop, crop, 0, 0, size, size);
  return canvas.toDataURL("image/jpeg", 0.86);
}

/** 随机挑一个与当前不同的头像，用于“一键换心情”。 */
export function randomAvatarId(excludeId?: string): string {
  const pool = AVATARS.filter((a) => a.id !== excludeId && a.id !== DEFAULT_AVATAR_ID);
  const list = pool.length > 0 ? pool : AVATARS;
  return list[Math.floor(Math.random() * list.length)].id;
}
