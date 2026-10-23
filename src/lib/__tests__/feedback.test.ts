import { beforeEach, describe, expect, it } from "vitest";
import { useFeedback } from "../../store/feedback";

describe("feedback dialog state", () => {
  beforeEach(() => {
    useFeedback.setState({
      toasts: [],
      confirmRequest: null,
      promptRequest: null,
    });
  });

  it("确认弹窗返回 true 并在结算后关闭", async () => {
    const pending = useFeedback.getState().confirm({
      title: "删除",
      message: "确认删除？",
      danger: true,
    });
    expect(useFeedback.getState().confirmRequest?.title).toBe("删除");

    useFeedback.getState().settleConfirm(true);

    await expect(pending).resolves.toBe(true);
    expect(useFeedback.getState().confirmRequest).toBeNull();
  });

  it("输入弹窗返回输入值", async () => {
    const pending = useFeedback.getState().prompt({
      title: "重命名",
      defaultValue: "old-name",
    });
    expect(useFeedback.getState().promptRequest?.defaultValue).toBe("old-name");

    useFeedback.getState().settlePrompt("new-name");

    await expect(pending).resolves.toBe("new-name");
    expect(useFeedback.getState().promptRequest).toBeNull();
  });

  it("新的弹窗会先结算旧确认，避免 Promise 悬挂", async () => {
    const first = useFeedback.getState().confirm({ message: "第一次确认" });
    const second = useFeedback.getState().prompt({ title: "第二次输入" });

    await expect(first).resolves.toBe(false);
    expect(useFeedback.getState().confirmRequest).toBeNull();
    expect(useFeedback.getState().promptRequest?.title).toBe("第二次输入");

    useFeedback.getState().settlePrompt(null);
    await expect(second).resolves.toBeNull();
  });
});
