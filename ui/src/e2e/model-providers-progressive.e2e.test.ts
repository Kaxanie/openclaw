import { writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { beforeEach, afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApplicationRouter } from "../app-routes.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  waitForControlUiRoute,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const recordVisuals = process.env.OPENCLAW_UI_E2E_RECORD === "1";
let artifactDir: string;
beforeEach(() => {
  if (recordVisuals) {
    artifactDir = createControlUiE2eArtifactDir(
      "model-providers-progressive",
      process.env.OPENCLAW_UI_E2E_PROOF_DIR,
    );
  }
});

describeControlUiE2e("Control UI progressive Model Providers loading", () => {
  let browser: Browser;
  let server: ControlUiE2eServer;

  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("keeps a Models route selection saved before the initial provider details arrive", async () => {
    const context = await browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const initial = { agents: { defaults: { model: "fixture/initial" } } };
    const saved = { agents: { defaults: { model: "fixture/chosen" } } };
    const models = [
      { id: "initial", name: "Initial model", provider: "fixture", available: true },
      { id: "chosen", name: "Chosen model", provider: "fixture", available: true },
    ];
    const snapshot = (config: typeof initial, hash: string) => ({
      config,
      sourceConfig: config,
      hash,
      raw: JSON.stringify(config),
      valid: true,
    });
    const gateway = await installMockGateway(page, {
      defaultAgentId: "main",
      deferredMethods: ["models.authStatus", "config.patch"],
      models,
      methodResponses: {
        "models.list": { models, defaultModels: { automaticUtilityModel: "fixture/initial" } },
        "config.get": snapshot(initial, "initial-settings"),
        "models.authStatus": { ts: 1, providers: [] },
      },
    });
    try {
      await page.goto(`${server.baseUrl}settings/appearance`);
      await waitForControlUiRoute(page, { routeId: "appearance" });
      await gateway.waitForRequest("config.get");
      await page.evaluate(async () => {
        const app = document.querySelector<
          HTMLElement & { runtime: { router: ApplicationRouter } }
        >("openclaw-app");
        const route = app?.runtime.router.getRoute("model-providers");
        if (!route) {
          throw new Error("Models route is unavailable");
        }
        await route.component();
      });
      await page.locator('a[href="/settings/model-providers"]').first().click();
      await gateway.waitForRequest("models.authStatus");
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              document.querySelector<HTMLElement & { loaderPending: boolean }>(
                "openclaw-model-providers-page",
              )?.loaderPending,
          ),
        )
        .toBe(true);
      const defaults = page.locator(".model-providers__defaults");
      const picker = defaults.locator("openclaw-select-picker").first();
      const trigger = picker.locator(".picker-select__trigger");
      await trigger.click();
      await picker.locator('[role="option"][data-value="fixture/chosen"]').click();
      await gateway.waitForRequest("config.patch");
      await gateway.setMethodResponse("config.get", snapshot(saved, "saved-settings"));
      await gateway.setMethodResponse("models.list", {
        models: [
          ...models,
          { id: "added", name: "Added model", provider: "fixture", available: true },
        ],
        defaultModels: { automaticUtilityModel: "fixture/chosen" },
      });
      await gateway.resolveDeferred("config.patch", {
        ok: true,
        config: saved,
        hash: "saved-settings",
      });
      await expect
        .poll(() => defaults.getByRole("status").textContent())
        .toContain("Defaults saved.");
      await expect.poll(() => trigger.isEnabled()).toBe(true);
      await gateway.resolveDeferred("models.authStatus");
      await waitForControlUiRoute(page, { routeId: "model-providers" });
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      expect(await trigger.textContent()).toContain("Chosen model");
      expect(await defaults.locator("#model-providers-utility-model").textContent()).toContain(
        "Auto · Chosen model",
      );
      await trigger.click();
      await expect
        .poll(() => picker.locator('[role="option"][data-value="fixture/added"]').isVisible())
        .toBe(true);
    } finally {
      await context.close();
    }
  });

  it.each(["snapshot", "ordinary"] as const)(
    "opens the Models route from %s catalog publication while auth is pending",
    async (publicationKind) => {
      const context = await browser.newContext({ locale: "en-US", serviceWorkers: "block" });
      const page = await context.newPage();
      const prepared = {
        id: "prepared",
        name: "Prepared model",
        provider: "fixture",
        available: true,
      };
      const older = { ...prepared, id: "older", name: "Older model" };
      const added = { ...prepared, id: "added", name: "New model" };
      const gateway = await installMockGateway(page, {
        defaultAgentId: "main",
        models: [older],
        heldMethods: ["models.list", "models.authStatus", "usage.status", "sessions.usage"],
        methodResponses: {
          "config.get": {
            config: { agents: { defaults: { model: "fixture/prepared" } } },
            hash: "prepared-settings-model",
            valid: true,
          },
          "models.authStatus": { ts: 1, providers: [] },
        },
      });
      try {
        if (publicationKind === "snapshot") {
          await page.goto(`${server.baseUrl}settings/model-providers`);
        } else {
          await page.goto(`${server.baseUrl}settings/appearance`);
          await waitForControlUiRoute(page, { routeId: "appearance" });
          await page.locator('a[href="/settings/model-providers"]').first().click();
        }
        await gateway.waitForRequest("models.list");
        const publication = {
          target: {},
          scope: { agentId: "main" },
          catalog: {
            models: [prepared],
            defaultModels: { automaticUtilityModel: "fixture/prepared" },
          },
        };
        if (publicationKind === "snapshot") {
          await gateway.emitGatewayEvent("models.snapshot", publication);
        } else {
          await gateway.resolveDeferred("models.list", publication.catalog);
        }
        const picker = page.locator(".model-providers__defaults openclaw-select-picker").first();
        const trigger = picker.locator(".picker-select__trigger");
        await expect.poll(() => trigger.isEnabled()).toBe(true);
        await trigger.click();
        const preparedRow = picker.locator('[role="option"][data-value="fixture/prepared"]');
        await expect.poll(() => preparedRow.isVisible()).toBe(true);
        await expect.poll(() => preparedRow.textContent()).toContain("Prepared model");
        expect(await preparedRow.isEnabled()).toBe(true);
        expect(await gateway.getRequests("models.list")).toHaveLength(1);

        await gateway.resolveDeferred("models.authStatus");
        await waitForControlUiRoute(page, { routeId: "model-providers" });
        expect(await trigger.getAttribute("aria-expanded")).toBe("true");

        if (publicationKind === "snapshot") {
          await gateway.resolveDeferred("models.list", { models: [older] });
        }
        await expect.poll(() => preparedRow.isVisible()).toBe(true);
        expect(await picker.locator('[data-value="fixture/older"]').count()).toBe(0);

        await gateway.deferNext("models.list");
        await gateway.emitGatewayEvent("chat.metadata.changed", {});
        await expect.poll(async () => (await gateway.getRequests("models.list")).length).toBe(2);
        expect(await trigger.getAttribute("aria-expanded")).toBe("true");
        await gateway.resolveDeferred("models.list", {
          models: [prepared, added],
          defaultModels: { automaticUtilityModel: "fixture/added" },
        });
        await expect
          .poll(() => picker.locator('[role="option"][data-value="fixture/added"]').isVisible())
          .toBe(true);
        expect(await trigger.getAttribute("aria-expanded")).toBe("true");
      } finally {
        await context.close();
      }
    },
  );

  it.each(["cold", "prewarmed", "cached"] as const)(
    "renders provider controls before usage and cost settle (%s module)",
    async (moduleState) => {
      const context = await browser.newContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1_000, width: 1_280 },
        ...(recordVisuals
          ? { recordVideo: { dir: artifactDir, size: { height: 1_000, width: 1_280 } } }
          : {}),
      });
      const page = await context.newPage();
      const now = Date.now();
      const gateway = await installMockGateway(page, {
        models: [{ id: "gpt-5.5", name: "GPT-5.5", provider: "openai", available: true }],
        heldMethods:
          moduleState === "cached"
            ? []
            : [
                "usage.status",
                "sessions.usage",
                ...(moduleState === "cold" ? ["models.authStatus"] : []),
              ],
        methodResponses: {
          "config.get": {
            config: { agents: { defaults: { model: "openai/gpt-5.5" } } },
            sourceConfig: {},
            hash: "progressive-model-providers",
            issues: [],
            raw: "{}",
            valid: true,
          },
          "models.authStatus": {
            ts: now,
            providers: [
              {
                provider: "openai",
                displayName: "OpenAI",
                status: "static",
                profiles: [],
                apiKey: { source: "env", envVar: "OPENAI_API_KEY" },
              },
            ],
          },
          "usage.status": {
            updatedAt: now,
            providers: [{ provider: "openai", displayName: "OpenAI", plan: "Pro", windows: [] }],
          },
          "sessions.usage": {
            aggregates: {
              byProvider: [
                {
                  provider: "openai",
                  count: 1,
                  totals: { totalTokens: 100, totalCost: 1.25 },
                },
              ],
            },
          },
        },
      });

      try {
        const previousLoads = moduleState === "cached" ? 1 : 0;
        let previousAuthLoads = 0;
        if (moduleState === "cached") {
          await page.goto(`${server.baseUrl}settings/appearance`);
          await waitForControlUiRoute(page, { routeId: "appearance" });
          await page.locator('a[href="/settings/model-providers"]').first().click();
          await waitForControlUiRoute(page, { routeId: "model-providers" });
          await expect
            .poll(() => page.locator('[data-provider-id="openai"]').textContent())
            .toContain("$1.25");
          await page.locator('a[href="/settings/appearance"]').first().click();
          await waitForControlUiRoute(page, { routeId: "appearance" });
          await gateway.deferNext("usage.status");
          await gateway.deferNext("sessions.usage");
        }
        if (moduleState !== "cold") {
          if (moduleState === "prewarmed") {
            await page.goto(`${server.baseUrl}settings/appearance`);
          }
          await waitForControlUiRoute(page, { routeId: "appearance" });
          await gateway.deferNext("models.authStatus");
          previousAuthLoads = (await gateway.getRequests("models.authStatus")).length;
          await page.evaluate(async () => {
            const app = document.querySelector<
              HTMLElement & { runtime: { router: ApplicationRouter } }
            >("openclaw-app");
            const route = app?.runtime.router.getRoute("model-providers");
            if (!route) {
              throw new Error("Models route is unavailable");
            }
            await route.component();
          });
          await page.locator('a[href="/settings/model-providers"]').first().click();
        } else {
          expect((await page.goto(`${server.baseUrl}settings/model-providers`))?.status()).toBe(
            200,
          );
        }
        if (moduleState === "cold") {
          await gateway.waitForRequest("models.authStatus");
        } else {
          await expect
            .poll(async () => (await gateway.getRequests("models.authStatus")).length)
            .toBeGreaterThan(previousAuthLoads);
        }
        await page.locator("openclaw-model-providers-page").waitFor();
        if (moduleState === "cached") {
          await expect
            .poll(() => page.locator('[data-provider-id="openai"]').textContent())
            .toContain("Credentials configured");
          await expect
            .poll(() => page.locator('[data-provider-id="openai"]').textContent())
            .toContain("Loading");
        }
        if (recordVisuals) {
          await writeFile(
            path.join(artifactDir, "route-pending.png"),
            await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
              page.locator("openclaw-model-providers-page"),
            ]),
          );
        }
        expect(await gateway.getRequests("usage.status")).toHaveLength(previousLoads);
        expect(await gateway.getRequests("sessions.usage")).toHaveLength(previousLoads);
        await gateway.resolveDeferred("models.authStatus");
        await waitForControlUiRoute(page, { routeId: "model-providers" });
        await gateway.waitForRequest("usage.status");
        await gateway.waitForRequest("sessions.usage");
        const provider = page.locator('[data-provider-id="openai"]');
        await provider.waitFor();
        await expect.poll(async () => provider.textContent()).toContain("Credentials configured");
        await expect.poll(async () => provider.textContent()).toContain("Loading");
        expect(await gateway.getRequests("usage.status")).toHaveLength(previousLoads + 1);
        expect(await gateway.getRequests("sessions.usage")).toHaveLength(previousLoads + 1);
        if (recordVisuals) {
          await writeFile(
            path.join(artifactDir, "before.png"),
            await takeControlUiViewportScreenshot(page, page.locator(".shell"), [provider]),
          );
        }

        await gateway.resolveDeferred("usage.status");
        await expect.poll(async () => provider.textContent()).toContain("Pro");
        expect(await provider.textContent()).not.toContain("$1.25");
        if (recordVisuals) {
          await writeFile(
            path.join(artifactDir, "usage-ready.png"),
            await takeControlUiViewportScreenshot(page, page.locator(".shell"), [provider]),
          );
        }

        await gateway.resolveDeferred("sessions.usage");
        await expect.poll(async () => provider.textContent()).toContain("$1.25");
        expect(await gateway.getRequests("usage.status")).toHaveLength(previousLoads + 1);
        expect(await gateway.getRequests("sessions.usage")).toHaveLength(previousLoads + 1);
        expect(await page.locator('[data-provider-id="unknown-provider"]').count()).toBe(0);
        if (recordVisuals) {
          await writeFile(
            path.join(artifactDir, "after.png"),
            await takeControlUiViewportScreenshot(page, page.locator(".shell"), [provider]),
          );
        }
      } finally {
        if (recordVisuals) {
          await writeFile(
            path.join(artifactDir, "final.png"),
            await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
              page.locator("openclaw-model-providers-page"),
            ]),
          );
        }
        await context.close();
      }
    },
  );
});
