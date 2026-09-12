import { describe, expect, it, vi } from "vitest";
import { settlePluginInstallTransactions } from "./install-transaction.js";

describe("plugin install transaction settlement", () => {
  it.each(["commit", "rollback"] as const)(
    "does not replay a successful %s through duplicate or later settlement",
    async (action) => {
      const transaction = { commit: vi.fn(async () => {}), rollback: vi.fn(async () => {}) };

      await Promise.all([
        settlePluginInstallTransactions([transaction, transaction], action),
        settlePluginInstallTransactions([transaction], action),
      ]);
      await settlePluginInstallTransactions([transaction], "commit");
      await settlePluginInstallTransactions([transaction], "rollback");

      expect(transaction[action]).toHaveBeenCalledOnce();
      expect(transaction[action === "commit" ? "rollback" : "commit"]).not.toHaveBeenCalled();
    },
  );

  it("retains failed rollback for recovery without replaying settled siblings", async () => {
    const failure = new Error("backup restore failed");
    const settled = { commit: vi.fn(async () => {}), rollback: vi.fn(async () => {}) };
    const pending = {
      commit: vi.fn(async () => {}),
      rollback: vi.fn<() => Promise<void>>().mockRejectedValueOnce(failure).mockResolvedValue(),
    };
    await expect(
      settlePluginInstallTransactions([pending, settled], "rollback"),
    ).rejects.toMatchObject({
      errors: [failure],
    });
    await settlePluginInstallTransactions([pending, settled], "rollback");
    expect(pending.rollback).toHaveBeenCalledTimes(2);
    expect(settled.rollback).toHaveBeenCalledOnce();
  });
});
