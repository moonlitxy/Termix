import { describe, expect, it } from "vitest";
import { AUTH_METHODS, authMethodLabel, canBeJumpTarget, validateJumpSelection } from "../sshAuth";

const sessions = [
  { id: "a", name: "直连机", jumpSessionId: undefined },
  { id: "b", name: "经跳板机", jumpSessionId: "a" },
];

describe("sshAuth 认证与跳板", () => {
  it("四种认证方式齐全", () => {
    expect(AUTH_METHODS.map((m) => m.id)).toEqual(["password", "key", "keyboard", "agent"]);
    expect(authMethodLabel("keyboard")).toContain("2FA");
    expect(authMethodLabel("unknown")).toBe("unknown");
  });

  it("跳板候选排除自身与嵌套", () => {
    expect(canBeJumpTarget(sessions[0], "self")).toBe(true);
    expect(canBeJumpTarget(sessions[0], "a")).toBe(false);
    expect(canBeJumpTarget(sessions[1])).toBe(false);
  });

  it("跳板选择校验", () => {
    expect(validateJumpSelection(undefined, "x", sessions)).toBeNull();
    expect(validateJumpSelection("x", "x", sessions)).toBe("跳板机不能是自身");
    expect(validateJumpSelection("gone", "x", sessions)).toContain("不存在");
    expect(validateJumpSelection("b", "x", sessions)).toContain("一级跳板");
    expect(validateJumpSelection("a", "x", sessions)).toBeNull();
  });
});
