import { beforeEach, describe, expect, it, vi } from "vitest";
import { AVATARS, AVATAR_NAME_MAX, CUSTOM_AVATAR_ID, CUSTOM_AVATAR_KEY, DEFAULT_AVATAR_ID, getAvatar, isDefaultAvatar, loadAvatarId, loadAvatarNames, loadCustomAvatar, randomAvatarId, saveAvatarId, saveAvatarName, saveCustomAvatar, validateAvatarFile } from "../avatar";

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

  it("内置 6 张二次元头像", () => {
    const ids = AVATARS.map((a) => a.id);
    expect(ids).toEqual(["mint", "azure", "chestnut", "yukino", "shion", "whale"]);
    expect(AVATARS.every((a) => a.src.length > 0)).toBe(true);
  });

  it("未知 id 回退到默认头像", () => {
    expect(getAvatar("not-exists").id).toBe(DEFAULT_AVATAR_ID);
    expect(getAvatar(undefined).id).toBe(DEFAULT_AVATAR_ID);
  });

  it("读写 localStorage 持久化", () => {
    expect(loadAvatarId()).toBe(DEFAULT_AVATAR_ID);
    saveAvatarId("azure");
    expect(loadAvatarId()).toBe("azure");
    saveAvatarId("not-exists");
    expect(loadAvatarId()).toBe("azure");
    saveAvatarId(DEFAULT_AVATAR_ID);
    expect(loadAvatarId()).toBe(DEFAULT_AVATAR_ID);
    expect(isDefaultAvatar(loadAvatarId())).toBe(true);
  });

  it("随机头像避开当前", () => {
    for (let i = 0; i < 20; i += 1) {
      expect(randomAvatarId("mint")).not.toBe("mint");
      expect(randomAvatarId(DEFAULT_AVATAR_ID)).not.toBe(DEFAULT_AVATAR_ID);
    }
  });

  it("自定义头像独立持久化且不覆盖内置头像", () => {
    expect(loadCustomAvatar()).toBe("");
    saveCustomAvatar("data:image/jpeg;base64,test");
    expect(localStorage.getItem(CUSTOM_AVATAR_KEY)).toBe("data:image/jpeg;base64,test");
    expect(loadCustomAvatar()).toBe("data:image/jpeg;base64,test");
    saveAvatarId(CUSTOM_AVATAR_ID);
    expect(loadAvatarId()).toBe(CUSTOM_AVATAR_ID);
    expect(AVATARS.map((avatar) => avatar.id)).not.toContain(CUSTOM_AVATAR_ID);
  });

  it("头像名称按头像持久化，空值删除并回退默认名称", () => {
    expect(loadAvatarNames()).toEqual({});
    saveAvatarName("default", "  鲸鱼娘  ");
    saveAvatarName("mint", "薄荷");
    expect(loadAvatarNames()).toEqual({ default: "鲸鱼娘", mint: "薄荷" });
    saveAvatarName("mint", "");
    expect(loadAvatarNames()).toEqual({ default: "鲸鱼娘" });
    saveAvatarName("default", "x".repeat(AVATAR_NAME_MAX + 10));
    expect(loadAvatarNames().default).toHaveLength(AVATAR_NAME_MAX);
  });

  it("上传文件限制类型与大小", () => {
    const valid = new File(["avatar"], "avatar.png", { type: "image/png" });
    const invalidType = new File(["avatar"], "avatar.txt", { type: "text/plain" });
    const oversized = new File([new Uint8Array(8 * 1024 * 1024 + 1)], "avatar.png", {
      type: "image/png",
    });
    expect(validateAvatarFile(valid)).toBeNull();
    expect(validateAvatarFile(invalidType)).not.toBeNull();
    expect(validateAvatarFile(oversized)).not.toBeNull();
  });
});
