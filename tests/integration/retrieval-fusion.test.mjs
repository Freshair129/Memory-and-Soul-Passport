// AC-02: retrieval/fusion.mjs's RRF is unit-tested as a pure function --
// deterministic ordering, correct 1/(k+rank) accumulation across overlapping
// and disjoint lists, configurable k -- with no DB or network anywhere in
// this file.
import { describe, expect, it } from "vitest";

import { rrfFuse } from "@freshair129/msp-retrieval/fusion";

describe("retrieval/fusion.mjs rrfFuse (AC-02)", () => {
  it("returns [] for no lists / all-empty lists", () => {
    expect(rrfFuse([])).toEqual([]);
    expect(rrfFuse([[], []])).toEqual([]);
  });

  it("skips non-array entries in hitLists rather than throwing (callers may pass an empty leg through)", () => {
    const list = [{ id: "a" }, { id: "b" }];
    expect(rrfFuse([list, null, undefined]).map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("a single ranked list: score is exactly 1/(k+rank) for each item, in rank order", () => {
    const list = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const fused = rrfFuse([list], { k: 60 });
    expect(fused.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(fused[0].score).toBeCloseTo(1 / 61, 10);
    expect(fused[1].score).toBeCloseTo(1 / 62, 10);
    expect(fused[2].score).toBeCloseTo(1 / 63, 10);
  });

  it("disjoint lists: every item appears once, fused score equals its own single contribution", () => {
    const listA = [{ id: "a" }, { id: "b" }];
    const listB = [{ id: "x" }, { id: "y" }];
    const fused = rrfFuse([listA, listB], { k: 10 });
    const byId = Object.fromEntries(fused.map((item) => [item.id, item.score]));
    expect(byId.a).toBeCloseTo(1 / 11, 10);
    expect(byId.b).toBeCloseTo(1 / 12, 10);
    expect(byId.x).toBeCloseTo(1 / 11, 10);
    expect(byId.y).toBeCloseTo(1 / 12, 10);
  });

  it("overlapping lists: an id present in both lists accumulates BOTH contributions, and outranks a single-list item with a higher raw rank", () => {
    // "shared" is rank 2 in list A and rank 1 in list B: 1/(60+2) + 1/(60+1).
    // "onlyA" is rank 1 in list A only: 1/(60+1).
    const listA = [{ id: "onlyA" }, { id: "shared" }];
    const listB = [{ id: "shared" }, { id: "onlyB" }];
    const fused = rrfFuse([listA, listB], { k: 60 });

    const byId = Object.fromEntries(fused.map((item) => [item.id, item.score]));
    expect(byId.shared).toBeCloseTo(1 / 62 + 1 / 61, 10);
    expect(byId.onlyA).toBeCloseTo(1 / 61, 10);
    expect(byId.onlyB).toBeCloseTo(1 / 62, 10);

    // "shared" accumulates two contributions and must rank first even though
    // "onlyA" has a better (rank 1) position in list A alone.
    expect(fused[0].id).toBe("shared");
  });

  it("k is configurable and changes the fused score", () => {
    const list = [{ id: "a" }];
    const withDefaultK = rrfFuse([list]);
    const withSmallK = rrfFuse([list], { k: 1 });
    expect(withDefaultK[0].score).toBeCloseTo(1 / 61, 10);
    expect(withSmallK[0].score).toBeCloseTo(1 / 2, 10);
    expect(withSmallK[0].score).not.toBeCloseTo(withDefaultK[0].score, 5);
  });

  it("deterministic ordering: repeated calls with the same input produce identical output, including tie-break order", () => {
    const listA = [{ id: "b" }, { id: "a" }];
    const listB = [{ id: "a" }, { id: "b" }];
    // Both "a" and "b" appear once in each list at swapped ranks --
    // symmetric contributions, so their fused scores tie exactly. The tie
    // must break deterministically (by id) rather than by insertion order,
    // which could otherwise vary with Map iteration/engine behavior.
    const first = rrfFuse([listA, listB]);
    const second = rrfFuse([listA, listB]);
    expect(first.map((item) => item.id)).toEqual(second.map((item) => item.id));
    expect(first[0].score).toBeCloseTo(first[1].score, 10);
    expect(first.map((item) => item.id)).toEqual(["a", "b"]); // "a" < "b" lexicographically
  });

  it("preserves non-score fields carried on the first-registered occurrence of an item", () => {
    const listA = [{ id: "a", entity: { name: "from-a" } }];
    const listB = [{ id: "a", entity: { name: "from-b" } }];
    const fused = rrfFuse([listA, listB]);
    expect(fused[0].entity.name).toBe("from-a");
  });

  it("throws a TypeError, not a silent failure, for malformed input", () => {
    expect(() => rrfFuse("not-an-array")).toThrow(TypeError);
    expect(() => rrfFuse([[{ noId: true }]])).toThrow(TypeError);
    expect(() => rrfFuse([[{ id: "a" }]], { k: 0 })).toThrow(TypeError);
    expect(() => rrfFuse([[{ id: "a" }]], { k: -5 })).toThrow(TypeError);
  });
});
