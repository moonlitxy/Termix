import type { Tab } from "../types";

/** 基于主标签创建一个隐藏的分屏 pane 标签。 */
export function createSplitTab(
  parent: Pick<Tab, "id" | "kind" | "sessionId" | "title">,
  id: string
): Tab {
  return {
    id,
    kind: parent.kind,
    sessionId: parent.sessionId,
    title: parent.title,
    status: "connecting",
    hidden: true,
    splitOf: parent.id,
  };
}
