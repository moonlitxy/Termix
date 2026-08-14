/** 命令片段变量占位符的纯逻辑：解析声明、扫描占位符、按值替换 */

export interface VarDef {
  name: string;
  defaultValue: string;
}

/** 匹配 `{{name}}`，允许变量名两侧有空白，如 `{{ var }}` */
const PLACEHOLDER_RE = /\{\{\s*([\w-]+)\s*\}\}/g;

/** 解析片段 variables 字段（JSON 字符串数组），失败或非法时返回空数组 */
export function parseVariables(raw?: string): VarDef[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((v) => ({
        name: String(v?.name ?? ""),
        defaultValue: v?.default != null ? String(v.default) : "",
      }))
      .filter((v) => v.name);
  } catch {
    return [];
  }
}

/** 扫描命令中的 `{{var}}` 占位符，返回变量名列表（保持出现顺序） */
export function scanPlaceholders(command: string): string[] {
  return [...command.matchAll(PLACEHOLDER_RE)].map((m) => m[1]);
}

/**
 * 合并扫描与声明：返回命令中每个占位符的变量定义（名称 + 声明中的默认值）。
 * 供片段插入与快捷命令面板共用，保证两者变量弹窗行为一致。
 */
export function buildVarDefs(command: string, variables?: string): VarDef[] {
  const declared = parseVariables(variables);
  return scanPlaceholders(command).map((name) => ({
    name,
    defaultValue: declared.find((d) => d.name === name)?.defaultValue ?? "",
  }));
}

/**
 * 用变量值替换命令中的占位符（与扫描使用同一正则，保证 `{{ var }}` 也能被替换）。
 * 未提供值的变量替换为空字符串。
 */
export function applyVariables(command: string, values: Record<string, string>): string {
  return command.replace(PLACEHOLDER_RE, (_match, name: string) => values[name] ?? "");
}
