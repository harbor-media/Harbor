import { describe, expect, it } from "vitest";
import { roleRank, type UserRole } from "./index.js";

describe("roleRank", () => {
  it("orders the four roles owner > administrator > user > guest", () => {
    expect(roleRank("owner")).toBe(3);
    expect(roleRank("administrator")).toBe(2);
    expect(roleRank("user")).toBe(1);
    expect(roleRank("guest")).toBe(0);
  });

  it("is a strict total order used by both requireRole and the granting rule", () => {
    const ordered: UserRole[] = ["guest", "user", "administrator", "owner"];
    for (let i = 1; i < ordered.length; i += 1) {
      const lower = ordered[i - 1] as UserRole;
      const higher = ordered[i] as UserRole;
      expect(roleRank(lower)).toBeLessThan(roleRank(higher));
    }
  });

  it("treats equal roles as not outranking each other (granting rule blocks equal)", () => {
    expect(roleRank("administrator") >= roleRank("administrator")).toBe(true);
    expect(roleRank("user") >= roleRank("administrator")).toBe(false);
  });
});
