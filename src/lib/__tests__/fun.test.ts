import { describe, expect, it } from "vitest";
import { FUN_AVATAR_TIPS, FUN_MONITOR_EMPTY, FUN_SFTP_EMPTY, pickFun } from "../fun";

describe("fun 趣味文案", () => {
  it("各类空状态都有文案", () => {
    expect(FUN_SFTP_EMPTY.length).toBeGreaterThan(0);
    expect(FUN_MONITOR_EMPTY.length).toBeGreaterThan(0);
    expect(FUN_AVATAR_TIPS.length).toBeGreaterThan(0);
  });

  it("按序号稳定挑选", () => {
    expect(pickFun(FUN_SFTP_EMPTY, 0)).toBe(FUN_SFTP_EMPTY[0]);
    expect(pickFun(FUN_SFTP_EMPTY, FUN_SFTP_EMPTY.length)).toBe(FUN_SFTP_EMPTY[0]);
    expect(pickFun([], 3)).toBe("");
  });
});
