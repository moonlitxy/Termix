import { describe, expect, it } from "vitest";
// @ts-ignore vitest node 环境提供 fs / path
import { readFileSync } from "node:fs";
// @ts-ignore vitest node 环境提供 fs / path
import { join } from "node:path";

declare const process: { cwd: () => string };

describe("GlobalTooltip 与 CommandInput 交互回归", () => {
  const tooltipSrc = readFileSync(
    join(process.cwd(), "src/components/GlobalTooltip.tsx"),
    "utf-8"
  );
  const cmdInputSrc = readFileSync(
    join(process.cwd(), "src/components/CommandInput.tsx"),
    "utf-8"
  );
  const cssSrc = readFileSync(
    join(process.cwd(), "src/styles/global.css"),
    "utf-8"
  );
  const railSrc = readFileSync(
    join(process.cwd(), "src/components/ActivityRail.tsx"),
    "utf-8"
  );
  const tabsSrc = readFileSync(
    join(process.cwd(), "src/components/EditorTabs.tsx"),
    "utf-8"
  );
  const settingsSrc = readFileSync(
    join(process.cwd(), "src/components/SettingsView.tsx"),
    "utf-8"
  );
  const titlebarSrc = readFileSync(
    join(process.cwd(), "src/components/TitleBar.tsx"),
    "utf-8"
  );
  const statusbarSrc = readFileSync(
    join(process.cwd(), "src/components/StatusBar.tsx"),
    "utf-8"
  );
  const monitorSrc = readFileSync(
    join(process.cwd(), "src/components/MonitorView.tsx"),
    "utf-8"
  );
  const sidebarStatsSrc = readFileSync(
    join(process.cwd(), "src/components/SidebarStats.tsx"),
    "utf-8"
  );
  const appSrc = readFileSync(join(process.cwd(), "src/App.tsx"), "utf-8");
  const sftpSrc = readFileSync(
    join(process.cwd(), "src/components/SftpView.tsx"),
    "utf-8"
  );

  it("GlobalTooltip 动态计算箭头偏移量 --tooltip-arrow-x 并保留边角边距", () => {
    expect(tooltipSrc).toContain("--tooltip-arrow-x");
    expect(tooltipSrc).toContain("rawArrowX = tip.x - tooltipLeft");
    expect(tooltipSrc).toContain("Math.min(el.offsetWidth - 10, Math.max(10, rawArrowX))");
  });

  it("global.css 中箭头使用 --tooltip-arrow-x 动态定位", () => {
    expect(cssSrc).toContain("left: var(--tooltip-arrow-x, 50%);");
  });

  it("CommandInput 历史项包含独立的复制按钮与执行按钮", () => {
    expect(cmdInputSrc).toContain("copyCommand");
    expect(cmdInputSrc).toContain("executeFromHistory");
    expect(cmdInputSrc).toContain("command-input__history-actions");
    expect(cmdInputSrc).toContain("command-input__history-action-btn");
    expect(cmdInputSrc).toContain("cmdinput.copied");
    expect(cmdInputSrc).toContain("cmdinput.copyTitle");
    expect(cmdInputSrc).toContain("cmdinput.execCmdTitle");
  });

  it("CommandInput 挂载时立即拉取历史且支持事件冒泡", () => {
    expect(cmdInputSrc).toContain("void reload();");
    expect(cmdInputSrc).toContain("{ bubbles: true }");
  });

  it("历史弹层宽度适配动作按钮", () => {
    expect(cssSrc).toContain("width: 440px;");
  });

  it("首页活动栏不再保留左下角设置/帮助入口", () => {
    expect(railSrc).not.toContain("BOTTOM_ITEMS");
    expect(railSrc).not.toContain('id: "settings"');
    expect(railSrc).not.toContain('id: "help"');
  });

  it("标签栏提供 + 新建入口与最近连接菜单", () => {
    expect(tabsSrc).toContain("editor-tabs__add-btn");
    expect(tabsSrc).toContain("recentSessions");
    expect(tabsSrc).toContain('tr("tab.recentConnections")');
    expect(tabsSrc).toContain("openSessionTab");
  });

  it("设置页使用左侧分类导航与右侧内容布局", () => {
    expect(settingsSrc).toContain("st-view--split");
    expect(settingsSrc).toContain("st-nav__list");
    expect(settingsSrc).toContain("filteredCategories");
    expect(settingsSrc).toContain("data-active-cat");
    expect(settingsSrc).toContain("FONT_FAMILIES");
    expect(settingsSrc).toContain("st.fontFamily");
  });

  it("状态栏不再重复显示当前目录路径", () => {
    expect(statusbarSrc).not.toContain("remotePath");
    expect(statusbarSrc).not.toContain("status-bar__center");
  });

  it("SFTP 收起后终端吃掉剩余高度，折叠条只保留工具栏", () => {
    expect(appSrc).toContain("sftpCollapsed ? 1 : 1 - sftpRatio");
    expect(cssSrc).toContain("flex-basis: 37px;");
  });

  it("SFTP 文件名列吸收剩余宽度，修改时间列保证完整显示", () => {
    expect(cssSrc).toContain(
      "grid-template-columns: minmax(var(--sftp-name), 1fr)"
    );
    expect(sftpSrc).toContain("mtime: 136");
  });

  it("监控页复用连接建立时预取的系统信息", () => {
    expect(monitorSrc).toContain("s.sysInfo");
    expect(monitorSrc).toContain("aria-busy");
    expect(monitorSrc).not.toContain("ipc.systemInfo");
  });

  it("左侧资源占用改为细轨道与右侧百分比", () => {
    expect(sidebarStatsSrc).toContain("sidebar-stat__track");
    expect(sidebarStatsSrc).toContain("sidebar-stat__pct");
    expect(sidebarStatsSrc).not.toContain("sidebar-stat__meter");
    expect(cssSrc).toContain(".sidebar-stat__track");
    expect(cssSrc).toContain("grid-template-rows: 18px auto;");
  });

  it("头像下拉包含用户卡片、主题语言和退出入口，并合并帮助入口", () => {
    expect(titlebarSrc).toContain("titlebar__avatar-card");
    expect(titlebarSrc).toContain("avatar.switchAvatar");
    expect(titlebarSrc).toContain("avatar.theme");
    expect(titlebarSrc).toContain("avatar.quitApp");
    expect(titlebarSrc).not.toContain("avatar.freeBadge");
    expect(titlebarSrc).not.toContain("avatar.shortcutsHelp");
    expect(titlebarSrc).not.toContain('openSettingsCategory("general")');
    expect(titlebarSrc).toContain('setActivity("help")');
  });
});
