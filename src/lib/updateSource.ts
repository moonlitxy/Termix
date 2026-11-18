import type { Settings } from "./settings";

/**
 * 软件更新源：直连（默认）/ 镜像加速 / 代理。
 *
 * 镜像清单均为 2026-11-18 在沙盒外实测可用：
 * - 版本接口（releases/latest）返回的 tag 与直连一致（v1.0.2）；
 * - 安装包（termix-v1.0.2-source.tar.gz，1245594 字节）与直连逐字节一致。
 * 其余候选（ghproxy.cn、ghproxy.net、mirror.ghproxy.com、gh.llkk.cc、
 * ghfast.top、github.moeyy.xyz 等）当时分别返回 403/非 JSON 桩页/超时，
 * 故未收录；网络环境变化后可用设置页「测试连接」自行验证。
 */

export type UpdateMode = "direct" | "mirror" | "proxy";

export interface UpdateMirror {
  id: string;
  name: string;
  /** 镜像基址（必须以 / 结尾），使用时直接拼原 URL */
  base: string;
  /** 实测结论展示给用户 */
  tested: string;
}

export const UPDATE_MIRRORS: UpdateMirror[] = [
  {
    id: "gh-proxy",
    name: "gh-proxy.com（推荐）",
    base: "https://gh-proxy.com/",
    tested: "2026-11-18 实测可用：版本一致，安装包逐字节一致，约 2 秒",
  },
  {
    id: "gh-proxy-org",
    name: "gh-proxy.org",
    base: "https://gh-proxy.org/",
    tested: "2026-11-18 实测可用：版本一致，安装包逐字节一致，约 3 秒",
  },
];

export const CUSTOM_MIRROR_ID = "custom";

export function findMirror(id: string): UpdateMirror | undefined {
  return UPDATE_MIRRORS.find((m) => m.id === id);
}

/** 规范镜像基址：补 https://、补末尾 /；非法返回错误说明 */
export function normalizeMirrorBase(input: string): { base: string } | { error: string } {
  const raw = input.trim();
  if (!raw) return { error: "请填写镜像地址" };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !/^https?:\/\//i.test(raw)) {
    return { error: "镜像地址仅支持 http(s)" };
  }
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { error: "镜像地址格式不正确" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { error: "镜像地址仅支持 http(s)" };
  }
  const base = withScheme.endsWith("/") ? withScheme : `${withScheme}/`;
  return { base };
}

/** 规范代理地址：空表示不使用；仅支持 http(s)://host:port */
export function normalizeProxyUrl(input: string): { proxy: string } | { error: string } {
  const raw = input.trim();
  if (!raw) return { proxy: "" };
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { error: "代理地址格式不正确，如 http://127.0.0.1:7890" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { error: "代理仅支持 http(s)，如 http://127.0.0.1:7890" };
  }
  if (!url.port) return { error: "请填写代理端口，如 http://127.0.0.1:7890" };
  return { proxy: withScheme };
}

/** 原 URL 套镜像前缀（如 https://gh-proxy.com/https://api.github.com/…） */
export function applyMirror(url: string, base: string): string {
  return `${base}${url}`;
}

export interface UpdateEndpoint {
  /** 传给后端的镜像基址（直连/代理模式为空串） */
  mirror: string;
  /** 传给后端的代理地址（不使用为空串） */
  proxy: string;
}

/** 由设置解析本次更新实际走的通道；配置非法时返回错误说明 */
export function resolveUpdateEndpoint(s: Pick<Settings, "updateMode" | "updateMirror" | "customMirror" | "updateProxy">): UpdateEndpoint | { error: string } {
  if (s.updateMode === "mirror") {
    const id = s.updateMirror || UPDATE_MIRRORS[0].id;
    if (id === CUSTOM_MIRROR_ID) {
      const r = normalizeMirrorBase(s.customMirror);
      if ("error" in r) return r;
      return { mirror: r.base, proxy: "" };
    }
    const m = findMirror(id) ?? UPDATE_MIRRORS[0];
    return { mirror: m.base, proxy: "" };
  }
  if (s.updateMode === "proxy") {
    const r = normalizeProxyUrl(s.updateProxy);
    if ("error" in r) return r;
    if (!r.proxy) return { error: "请先填写代理地址，如 http://127.0.0.1:7890" };
    return { mirror: "", proxy: r.proxy };
  }
  return { mirror: "", proxy: "" };
}

/** 设置页/弹窗展示用：当前通道一句话 */
export function describeUpdateEndpoint(s: Pick<Settings, "updateMode" | "updateMirror" | "customMirror" | "updateProxy">): string {
  const r = resolveUpdateEndpoint(s);
  if ("error" in r) return `直连（配置待完善：${r.error}）`;
  if (r.mirror) {
    const hit = UPDATE_MIRRORS.find((m) => m.base === r.mirror);
    return `镜像加速：${hit ? hit.name : r.mirror}`;
  }
  if (r.proxy) return `代理：${r.proxy}`;
  return "直连更新";
}
