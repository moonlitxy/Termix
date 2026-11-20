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

  it("内置 5 张二次元头像", () => {
    const ids = AVATARS.map((a) => a.id);
    expect(ids).toEqual(["mint", "azure", "chestnut", "yukino", "shion"]);
    expect(AVATARS.every((a) => a.src.length > 0)).toBe(true);
  });

  it("未知 id 回退到默认头像", () => {
    expect(getAvatar("not-exists").id).toBe("mint");
    expect(getAvatar(undefined).id).toBe("mint");
  });

  it("读写 localStorage 持久化", () => {
    expect(loadAvatarId()).toBe("mint");
    saveAvatarId("azure");
    expect(loadAvatarId()).toBe("azure");
    saveAvatarId("not-exists");
    expect(loadAvatarId()).toBe("azure");
  });

  it("随机头像避开当前", () => {
    for (let i = 0; i < 20; i += 1) {
      expect(randomAvatarId("mint")).not.toBe("mint");
    }
  });
});
