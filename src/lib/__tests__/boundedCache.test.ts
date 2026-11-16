import { describe, expect, it } from "vitest";
import { setBoundedTimestampCache } from "../boundedCache";

describe("setBoundedTimestampCache", () => {
  it("keeps the newest entries within the limit", () => {
    const cache = {
      old: { value: "old", ts: 1 },
      recent: { value: "recent", ts: 2 },
    };

    const next = setBoundedTimestampCache(
      cache,
      "newest",
      { value: "newest", ts: 3 },
      2
    );

    expect(Object.keys(next)).toEqual(["newest", "recent"]);
  });

  it("replaces an existing key without reducing the entry count", () => {
    const cache = {
      path: { value: "before", ts: 1 },
    };

    const next = setBoundedTimestampCache(
      cache,
      "path",
      { value: "after", ts: 2 },
      1
    );

    expect(next.path).toEqual({ value: "after", ts: 2 });
    expect(Object.keys(next)).toHaveLength(1);
  });
});
