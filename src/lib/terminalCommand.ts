export interface TerminalCommandTracker {
  /** 喂入 xterm onData 数据，返回本次完成的命令（回车/换行触发）。 */
  feed(data: string, fallback: () => string | null): string[];
}

/**
 * 跟踪终端当前输入行。Tab 补全、历史上下键等会改写行内容，
 * 此时清空键盘跟踪，回车时由 fallback 从终端缓冲提取完整命令。
 */
export function createTerminalCommandTracker(): TerminalCommandTracker {
  let cmdLine = "";
  return {
    feed(data, fallback) {
      const commands: string[] = [];
      if (data.startsWith("\x1b")) {
        if (data === "\x1b[A" || data === "\x1b[B") cmdLine = "";
        return commands;
      }
      for (const ch of data) {
        if (ch === "\r" || ch === "\n") {
          let cmd = cmdLine.trim();
          if (!cmd) cmd = fallback()?.trim() ?? "";
          if (cmd) commands.push(cmd);
          cmdLine = "";
        } else if (ch === "\u007f" || ch === "\b") {
          cmdLine = cmdLine.slice(0, -1);
        } else if (ch === "\u0003" || ch === "\u0015") {
          // Ctrl+C / Ctrl+U
          cmdLine = "";
        } else if (ch === "\u0017") {
          // Ctrl+W：删除最后一个词
          cmdLine = cmdLine.replace(/\s*\S+\s*$/, "");
        } else if (ch === "\t") {
          // 补全会改写当前行，交给 fallback 读取终端缓冲
          cmdLine = "";
        } else if (ch >= " " && ch !== "\u001b") {
          cmdLine += ch;
        }
      }
      return commands;
    },
  };
}
