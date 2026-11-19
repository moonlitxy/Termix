import { describe, expect, it } from "vitest";
import {
  CUSTOM_MIRROR_ID,
  UPDATE_MIRRORS,
  applyMirror,
  describeUpdateEndpoint,
  describeUpdateSource,
  findMirror,
  normalizeMirrorBase,
  normalizeProxyUrl,
  resolveUpdateEndpoint,
} from "../updateSource";

describe("updateSource 更新源", () => {
  it("内置镜像均为实测可用的 https 基址", () => {
    expect(UPDATE_MIRRORS.length).toBeGreaterThanOrEqual(2);
    for (const m of UPDATE_MIRRORS) {
      expect(m.base).toMatch(/^https:\/\/.+\/$/);
      expect(m.tested).toContain("实测可用");
    }
    expect(findMirror("gh-proxy")?.base).toBe("https://gh-proxy.com/");
    expect(findMirror("nope")).toBeUndefined();
  });

  it("镜像拼接为前缀模式", () => {
    expect(applyMirror("https://api.github.com/x", "https://gh-proxy.com/")).toBe(
      "https://gh-proxy.com/https://api.github.com/x"
    );
  });

  it("自定义镜像补全并校验", () => {
    expect(normalizeMirrorBase("gh-proxy.com")).toEqual({ base: "https://gh-proxy.com/" });
    expect(normalizeMirrorBase("  https://a.b/c  ")).toEqual({ base: "https://a.b/c/" });
    expect(normalizeMirrorBase("")).toEqual({ error: "请填写镜像地址" });
    expect(normalizeMirrorBase("ftp://a.b")).toHaveProperty("error");
  });

  it("代理仅支持 http(s) 且必须带端口", () => {
    expect(normalizeProxyUrl("")).toEqual({ proxy: "" });
    expect(normalizeProxyUrl("http://127.0.0.1:7890")).toEqual({ proxy: "http://127.0.0.1:7890" });
    expect(normalizeProxyUrl("127.0.0.1:7890")).toEqual({ proxy: "http://127.0.0.1:7890" });
    expect(normalizeProxyUrl("socks5://127.0.0.1:1080")).toHaveProperty("error");
    expect(normalizeProxyUrl("http://127.0.0.1")).toHaveProperty("error");
  });

  it("三档通道解析：默认直连", () => {
    const base = { updateMirror: "gh-proxy", customMirror: "", updateProxy: "" };
    expect(resolveUpdateEndpoint({ ...base, updateMode: "direct" })).toEqual({ mirror: "", proxy: "" });
    expect(resolveUpdateEndpoint({ ...base, updateMode: "mirror" })).toEqual({
      mirror: "https://gh-proxy.com/",
      proxy: "",
    });
    expect(
      resolveUpdateEndpoint({ updateMode: "mirror", updateMirror: CUSTOM_MIRROR_ID, customMirror: "m.example.com", updateProxy: "" })
    ).toEqual({ mirror: "https://m.example.com/", proxy: "" });
    expect(
      resolveUpdateEndpoint({ ...base, updateMode: "proxy", updateProxy: "127.0.0.1:7890" })
    ).toEqual({ mirror: "", proxy: "http://127.0.0.1:7890" });
    expect(resolveUpdateEndpoint({ ...base, updateMode: "proxy", updateProxy: "" })).toHaveProperty("error");
  });

  it("通道一句话描述", () => {
    expect(
      describeUpdateEndpoint({ updateMode: "direct", updateMirror: "gh-proxy", customMirror: "", updateProxy: "" })
    ).toBe("直连更新");
    expect(
      describeUpdateEndpoint({ updateMode: "mirror", updateMirror: "gh-proxy", customMirror: "", updateProxy: "" })
    ).toContain("gh-proxy.com");
  });

  it("按后端实际连通通道展示（回退时不误导）", () => {
    expect(describeUpdateSource("direct")).toBe("直连更新");
    expect(describeUpdateSource("")).toBe("直连更新");
    expect(describeUpdateSource("https://gh-proxy.com/")).toContain("gh-proxy.com");
    expect(describeUpdateSource("https://mirror.example.com/")).toContain("mirror.example.com");
  });
});
