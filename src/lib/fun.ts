/** 趣味文案：空状态/加载/切换时的轻松提示，不影响主流程。 */

export const FUN_SFTP_EMPTY = [
  "空空如也，风一样干净～",
  "这个目录在等第一块拼图 🧩",
  "狗狗巡逻过：这里很安全 🐶",
];

export const FUN_MONITOR_EMPTY = [
  "连上服务器，鲸鱼带你看海底数据 🐳",
  "暂无波浪，先去终端开个连接吧～",
];

export const FUN_AVATAR_TIPS = [
  "今天也是精神满满的一天！",
  "换个头像，换个心情～",
  "鲸鱼娘为你保驾护航 🐳",
];

/** 趣味文案英文版（界面语言为 English 时使用） */
export const FUN_SFTP_EMPTY_EN = [
  "Empty and breezy～",
  "This folder is waiting for its first piece 🧩",
  "Doggo patrolled: all clear here 🐶",
];

export const FUN_MONITOR_EMPTY_EN = [
  "Connect a server, and the whale will show you the data sea 🐳",
  "No waves yet — open a terminal connection first～",
];

export const FUN_AVATAR_TIPS_EN = [
  "Full of energy today!",
  "New avatar, new mood～",
  "The whale guards your voyage 🐳",
];

export type FunKind = "sftpEmpty" | "monitorEmpty" | "avatarTips";

/** 按界面语言取一条趣味文案 */
export function pickFunLocalized(kind: FunKind, seed = 0, lang: "zh" | "en" = "zh"): string {
  const table: Record<FunKind, Record<string, string[]>> = {
    sftpEmpty: { zh: FUN_SFTP_EMPTY, en: FUN_SFTP_EMPTY_EN },
    monitorEmpty: { zh: FUN_MONITOR_EMPTY, en: FUN_MONITOR_EMPTY_EN },
    avatarTips: { zh: FUN_AVATAR_TIPS, en: FUN_AVATAR_TIPS_EN },
  };
  return pickFun(table[kind][lang === "en" ? "en" : "zh"], seed);
}

/** 按序号稳定挑选一条趣味文案（便于测试与 SSR 稳定渲染）。 */
export function pickFun(list: string[], seed = 0): string {
  if (list.length === 0) return "";
  const idx = Math.abs(Math.floor(seed)) % list.length;
  return list[idx];
}
