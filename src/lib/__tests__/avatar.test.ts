import { beforeEach, describe, expect, it, vi } from "vitest";
import { AVATARS, getAvatar, loadAvatarId, randomAvatarId, saveAvatarId } from "../avatar";

function installStorageStub() {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
  });
}

describe("avatar 默认头像", () => {
  beforeEach(() => {
    installStorageStub();
  });

  it("首批包含狗狗与鲸鱼娘", () => {
    const ids = AVATARS.map((a) => a.id);
    expect(ids).toContain("dog");
    expect(ids).toContain("whale");
    expect(AVATARS.length).toBeGreaterThanOrEqual(4);
  });

  it("未知 id 回退到默认头像", () => {
    expect(getAvatar("not-exists").id).toBe("dog");
    expect(getAvatar(undefined).id).toBe("dog");
  });

  it("读写 localStorage 持久化", () => {
    expect(loadAvatarId()).toBe("dog");
    saveAvatarId("whale");
    expect(loadAvatarId()).toBe("whale");
    saveAvatarId("not-exists");
    expect(loadAvatarId()).toBe("whale");
  });

  it("随机头像避开当前", () => {
    for (let i = 0; i < 20; i += 1) {
      expect(randomAvatarId("dog")).not.toBe("dog");
    }
  });
});
