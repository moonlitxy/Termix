export interface CdIntent {
  /** 去掉引号/转义后的第一个参数；空字符串代表 cd 无参数 */
  target: string;
  needsHome: boolean;
}

/** 这些字符在 shell 中会被展开或改变控制流，客户端无法可靠推导最终目录 */
const UNRESOLVABLE = /[$`*?[\]{}()<>|;&]/;
/** 后台执行或管道中的 cd 不改变当前 shell 的目录 */
const UNSAFE_TRAILING_OPERATOR = /(^|[^&])&(?![&])|(^|[^|])\|(?![|])/;
/** 同一行后续还会切换目录时，不能只按第一条 cd 推断最终位置 */
const LATER_CWD_CHANGE =
  /(?:^|&&|\|\||;)\s*(?:builtin\s+)?(?:cd|pushd|popd)\b/;
const CONTAINS_CWD_CHANGE =
  /(?:^|[;&|])\s*(?:builtin\s+)?(?:cd|pushd|popd)\b/;

interface FirstArgument {
  value: string;
  tail: string;
}

function firstArgument(rest: string): FirstArgument | null {
  let text = rest.trimStart();
  if (text.startsWith("--") && (text.length === 2 || /\s/.test(text[2]))) {
    text = text.slice(2).trimStart();
  }
  if (!text) return { value: "", tail: "" };

  let out = "";
  let quote: '"' | "'" | null = null;
  let end = text.length;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === "\\" && quote === '"' && i + 1 < text.length) {
        i += 1;
        out += text[i];
      } else {
        out += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "\\" && i + 1 < text.length) {
      i += 1;
      out += text[i];
    } else if (/\s/.test(ch) || "&;|<>".includes(ch)) {
      end = i;
      break;
    } else {
      out += ch;
    }
  }
  if (quote) return null;
  const tail = text.slice(end).trimStart();
  return { value: out, tail };
}

/** 解析 cd/pushd 的目标；popd、cd -、带变量/通配符的命令返回 null。 */
export function parseCdIntent(command: string): CdIntent | null {
  const match = command
    .trim()
    .match(/^(?:builtin\s+)?(cd|pushd)\b(.*)$/s);
  if (!match) return null;
  const parsed = firstArgument(match[2]);
  if (!parsed) return null;
  const { value: target, tail } = parsed;
  if (UNSAFE_TRAILING_OPERATOR.test(tail)) return null;
  if (LATER_CWD_CHANGE.test(tail)) return null;
  if (match[1] === "pushd" && target === "") return null;
  if (!target && match[2].trim().startsWith("-")) return null;
  if (target === "-" || target.startsWith("-") || target.startsWith("+")) {
    return null;
  }
  if (UNRESOLVABLE.test(target)) return null;
  if (target.startsWith("~") && target !== "~" && !target.startsWith("~/")) {
    // ~user 需要远端用户目录映射，交给 SFTP expand 也不稳定，先不跟随
    return null;
  }
  return {
    target,
    needsHome: target === "" || target === "~" || target.startsWith("~/"),
  };
}

function joinRemote(base: string, child: string): string {
  if (!base) return child;
  if (!child) return base;
  return base.endsWith("/") ? base + child : `${base}/${child}`;
}

/** 把 cd 目标解析成逻辑绝对路径，最终由后端校验目标确实为目录。 */
export function resolveCdTarget(
  intent: CdIntent,
  currentPath: string,
  homePath: string
): string | null {
  const { target } = intent;
  if (!target) return homePath || null;
  if (target === "~") return homePath || null;
  if (target.startsWith("~/")) {
    return homePath ? joinRemote(homePath, target.slice(2)) : null;
  }
  if (target.startsWith("~")) return null;
  if (target.startsWith("/")) return target;
  return joinRemote(currentPath || "/", target);
}

/** 从一段可能多行的输入中找出最后一条 cd/pushd 命令。 */
export function findLastCdCommand(text: string): string | null {
  const lines = text
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (parseCdIntent(lines[i])) return lines[i];
    if (CONTAINS_CWD_CHANGE.test(lines[i])) return null;
  }
  return null;
}

/** 从带任意提示符的终端行中提取最后一条可解析的 cd/pushd。 */
export function extractCdFromLine(line: string): string | null {
  for (let i = line.length - 1; i >= 0; i -= 1) {
    const ch = line[i];
    if (ch !== "c" && ch !== "p" && ch !== "b") continue;
    const candidate = line.slice(i).trim();
    if (parseCdIntent(candidate)) return candidate;
  }
  return null;
}

/** 纯词法规范化 POSIX 路径（不解析符号链接），用于旧后端的兼容回退。 */
export function normalizeRemotePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join("/")}`;
}
