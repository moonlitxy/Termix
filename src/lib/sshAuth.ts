import type { AuthType, Session } from "../types";

/**
 * 认证方式元信息（新建/编辑连接对话框共用）。
 * - keyboard：键盘交互，连接时按服务端提示逐轮输入（2FA/挑战应答）；
 * - agent：使用本机 ssh-agent 中的密钥登录（需先 ssh-add）。
 */

export interface AuthMethodMeta {
  id: AuthType;
  label: string;
  hint: string;
}

export const AUTH_METHODS: AuthMethodMeta[] = [
  { id: "password", label: "密码", hint: "用户名 + 密码登录" },
  { id: "key", label: "私钥", hint: "使用本地私钥文件登录" },
  { id: "keyboard", label: "键盘交互（2FA）", hint: "连接时按服务器提示输入验证码" },
  { id: "agent", label: "SSH Agent", hint: "使用本机 ssh-agent 中的密钥登录" },
];

export function authMethodLabel(authType: string): string {
  return AUTH_METHODS.find((m) => m.id === authType)?.label ?? authType;
}

/** 跳板机是否可用：仅支持一级跳板（跳板自身不能再配跳板） */
export function canBeJumpTarget(
  candidate: Pick<Session, "id" | "jumpSessionId">,
  selfId?: string
): boolean {
  if (selfId && candidate.id === selfId) return false;
  return !candidate.jumpSessionId;
}

/**
 * 校验跳板选择：返回错误说明，无问题返回 null。
 * - 不能选自己；不能选带跳板的会话（仅一级跳板）；
 * - 目标会话不存在时同样报错（防止引用已删除会话）。
 */
export function validateJumpSelection(
  jumpId: string | undefined,
  selfId: string | undefined,
  sessions: Pick<Session, "id" | "name" | "jumpSessionId">[]
): string | null {
  if (!jumpId) return null;
  if (selfId && jumpId === selfId) return "跳板机不能是自身";
  const target = sessions.find((s) => s.id === jumpId);
  if (!target) return "所选跳板机会话不存在（可能已被删除）";
  if (target.jumpSessionId) return "仅支持一级跳板：所选会话本身已配置跳板机";
  return null;
}
