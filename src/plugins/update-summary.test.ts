import { describe, expect, it, vi } from "vitest";
import {
  createPluginUpdateTransactionState,
  finalizePluginUpdateSummary,
} from "./update-summary.js";

const repairPeerLinks = vi.hoisted(() => vi.fn());
vi.mock("./update-config.js", () => ({ repairOpenClawPeerLinksForNpmInstalls: repairPeerLinks }));

describe("plugin update finalization", () => {
  it.each([false, true])(
    "preserves the peer-link failure when rollback fails: %s",
    async (rollbackFails) => {
      const root = new Error("Cannot repair OpenClaw peer link: target is not a directory");
      const cleanup = new Error("Cannot restore plugin backup");
      repairPeerLinks.mockRejectedValueOnce(root);
      const rollback = vi.fn(async () => {
        if (rollbackFails) {
          throw cleanup;
        }
      });
      const transactionState = createPluginUpdateTransactionState({});
      transactionState.transactions.push({ commit: vi.fn(), rollback });

      const failure: unknown = await finalizePluginUpdateSummary({
        config: {},
        changed: true,
        outcomes: [],
        ranNpmInstaller: true,
        logger: {},
        transactionState,
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toContain(root.message);
      if (rollbackFails) {
        expect(failure).toMatchObject({ cause: root, errors: [root, cleanup] });
      } else {
        expect(failure).toBe(root);
      }
      expect(rollback).toHaveBeenCalledOnce();
    },
  );
});
