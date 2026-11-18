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

/** 按序号稳定挑选一条趣味文案（便于测试与 SSR 稳定渲染）。 */
export function pickFun(list: string[], seed = 0): string {
  if (list.length === 0) return "";
  const idx = Math.abs(Math.floor(seed)) % list.length;
  return list[idx];
}
