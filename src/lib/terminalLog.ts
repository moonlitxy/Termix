/** xterm 缓冲区的最小结构，便于脱离 DOM 单元测试。 */
export interface TerminalLogBuffer {
  length: number;
  getLine(
    index: number
  ): { translateToString(trimRight?: boolean): string } | undefined;
}

/** 将 xterm 缓冲区转换为纯文本日志，去掉尾部空行但保留中间空行。 */
export function terminalBufferToText(buffer: TerminalLogBuffer): string {
  const lines: string[] = [];
  for (let index = 0; index < buffer.length; index += 1) {
    const line = buffer.getLine(index);
    lines.push(line ? line.translateToString(true) : "");
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.join("\n");
}

/** 生成不包含路径分隔符和常见非法字符的日志文件名。 */
export function terminalLogFileName(title: string, now = new Date()): string {
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  const safeTitle = title.replace(/[\\/:*?"<>|]/g, "_").trim() || "terminal";
  return `termix-${safeTitle}-${stamp}.log`;
}
