import fs from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createSubsystemLogger, getChildLogger } from "../plugin-sdk/logging-core.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { createPluginRegistry } from "../plugins/registry.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { startPluginServices } from "../plugins/services.js";
import { readConfiguredLogTail } from "./log-tail.js";
import { createSuiteLogPathTracker } from "./log-test-helpers.js";
import { applyLoggingConfig, flushLogger, resetLogger } from "./logger.js";
import { testApi } from "./logger.test-support.js";
import { getDefaultRedactPatterns } from "./redact.js";
import { registerSecretValueForRedaction } from "./secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "./secret-redaction-registry.test-support.js";
import { loggingState } from "./state.js";

const paths = createSuiteLogPathTracker("openclaw-plugin-jsonl-");
const token = "synthetic-credential-123456";
const message = `--token "${token}"`;
const headers = Object.fromEntries(
  [
    "Authorization",
    "Proxy-Authorization",
    "Cookie",
    "Set-Cookie",
    "SetCookie",
    "set_cookie",
    "X-Api-Key",
    "X-Auth-Token",
    "X-Goog-Api-Key",
    "Api-Key",
    "apikey",
    "X-Api-Token",
    "X-Access-Token",
    "X-OpenClaw-Token",
    "x-pomerium-jwt-assertion",
  ].map((key) => [key, "opaque-value"]),
);
const maskedHeaders = Object.fromEntries(Object.keys(headers).map((key) => [key, "***"]));
let rawConsole: typeof loggingState.rawConsole;
function registerPlugin(logger: ReturnType<typeof createSubsystemLogger>, id: string) {
  const host = createPluginRegistry({
    logger,
    runtime: createPluginRuntime(),
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({
    id,
    source: import.meta.url,
    origin: "global",
    enabled: true,
    configSchema: false,
  });
  host.registry.plugins.push(record);
  return { api: host.createApi(record, { config: {} }), registry: host.registry };
}

beforeAll(async () => await paths.setup());
beforeEach(() => {
  rawConsole = loggingState.rawConsole;
});
afterEach(async () => {
  await flushLogger();
  testApi.resetFileLogTransportForTests();
  resetLogger();
  resetSecretRedactionRegistryForTest();
  loggingState.rawConsole = rawConsole;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
afterAll(async () => await paths.cleanup());

const patternCases = [
  { name: "default", custom: false, patterns: undefined },
  {
    name: "custom-only",
    custom: true,
    patterns: ["CUSTOM_ONLY_[A-Z]+", "synthetic-credential-[0-9]+"],
  },
  {
    name: "extended-defaults",
    custom: true,
    patterns: [...getDefaultRedactPatterns(), "CUSTOM_ONLY_[A-Z]+"],
  },
  { name: "copied-defaults", custom: false, patterns: getDefaultRedactPatterns() },
];

it.each([false, true])(
  "Gateway plugin service preserves anchored string patterns (custom-only=%s)",
  async (customOnly) => {
    vi.stubEnv("OPENCLAW_TEST_FILE_LOG", "1");
    vi.stubEnv("OPENCLAW_TEST_CONSOLE", "1");
    const file = paths.nextPath();
    applyLoggingConfig({
      level: "info",
      file,
      consoleStyle: "json",
      consoleLevel: "info",
      redactPatterns: [
        ...(customOnly ? [] : getDefaultRedactPatterns()),
        "^private-value$",
        "^private-marker",
      ],
    });
    const output = vi.fn();
    loggingState.rawConsole = { log: output, info: output, warn: output, error: output };
    const logger = createSubsystemLogger("anchored-record");
    const { api, registry } = registerPlugin(logger, "anchored-record");
    api.registerService({
      id: "anchored-record",
      start() {
        logger.info("anchored pattern", {
          value: "private-value",
          changed: "private-marker qwer-tyui-opas-dfgh",
        });
      },
    });
    const services = await startPluginServices({ registry, config: {} });
    await services.stop();
    await flushLogger();
    const records = fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const consoleRecords = output.mock.calls.map(([line]) => JSON.parse(String(line)));
    const tail = (await readConfiguredLogTail()).lines.map((line) => JSON.parse(line));
    expect(records).toHaveLength(1);
    expect(consoleRecords).toHaveLength(1);
    expect(tail).toHaveLength(1);
    for (const value of [records[0][1].value, consoleRecords[0].value, tail[0][1].value]) {
      expect(value).toBe("***");
    }
    for (const row of [records[0][1], consoleRecords[0], tail[0][1]]) {
      expect(row.changed).not.toContain("private-marker");
      expect(row.changed).not.toContain("qwer-tyui-opas-dfgh");
      expect(row.changed).toContain("…");
    }
  },
);

it.each([false, true])(
  "Gateway plugin service masks full-record contexts and every JSON scalar (custom-only=%s)",
  async (customOnly) => {
    vi.stubEnv("OPENCLAW_TEST_FILE_LOG", "1");
    vi.stubEnv("OPENCLAW_TEST_CONSOLE", "1");
    const file = paths.nextPath();
    applyLoggingConfig({
      level: "info",
      file,
      consoleStyle: "json",
      consoleLevel: "info",
      redactPatterns: [
        ...(customOnly ? [] : getDefaultRedactPatterns()),
        String.raw`/\{"account":"([^"]+)"/g`,
        String.raw`/"kind":"private","account":"([^"]+)"/g`,
        String.raw`/"account":\["([^"]+)"\]/g`,
        String.raw`/"account":(\d+)/g`,
        String.raw`/"enabled":(true|false)/g`,
        String.raw`/"nullable":(null)/g`,
        String.raw`/"block":(\[[^\]]+\])/g`,
        String.raw`/("combination":123456)/g`,
        String.raw`/"message":"message-only ([^"]+)"/g`,
      ],
    });
    const output = vi.fn();
    loggingState.rawConsole = { log: output, info: output, warn: output, error: output };
    const logger = createSubsystemLogger("full-record");
    const rawLogger = getChildLogger({ subsystem: "full-record" });
    const { api, registry } = registerPlugin(logger, "full-record");
    const credential = "CONTEXT_PRIVATE_VALUE";
    let conversions = 0;
    api.registerService({
      id: "full-record",
      start() {
        logger.info("brace context", {
          account: credential,
          ordinary: "visible",
          scenario: "brace",
        });
        logger.info("sibling context", {
          kind: "private",
          account: credential,
          scenario: "sibling",
        });
        logger.info("array context", { account: [credential], scenario: "array" });
        logger.info("scalar context", {
          account: 123456,
          enabled: true,
          nullable: null,
          scenario: "scalars",
        });
        logger.info("structure context", {
          block: [123456, false, null],
          keyAndValue: { combination: 123456 },
          scenario: "structure",
        });
        logger.info("password=value&safe=1", {
          scenario: "built-in",
          payload: "https://example.test/?password=value&safe=1",
        });
        logger.info("message-only opaque-value", { scenario: "display-only" });
        rawLogger.info(
          undefined,
          "derived context",
          new (class {
            toJSON() {
              conversions += 1;
              return { account: credential };
            }
          })(),
        );
      },
    });
    const services = await startPluginServices({ registry, config: {} });
    await services.stop();
    await flushLogger();
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    const records = lines.map((line) => JSON.parse(line));
    const consoleRecords = output.mock.calls.map(([line]) => JSON.parse(String(line)));
    const tail = await readConfiguredLogTail();
    expect(records).toHaveLength(8);
    expect(consoleRecords).toHaveLength(7);
    expect(tail.lines).toEqual(lines);
    for (const values of [
      records.slice(0, 5).map((record) => record[1]),
      consoleRecords.slice(0, 5),
    ]) {
      expect(values).toMatchObject([
        { scenario: "brace", account: "CONTEX…ALUE", ordinary: "visible" },
        { scenario: "sibling", kind: "private", account: "CONTEX…ALUE" },
        { scenario: "array", account: ["CONTEX…ALUE"] },
        { scenario: "scalars", account: "***", enabled: "***", nullable: "***" },
        {
          scenario: "structure",
          block: ["***", "***", "***"],
          keyAndValue: { "***": "***" },
        },
      ]);
    }
    expect(conversions).toBe(1);
    expect(records[5]).toMatchObject({
      "1": { payload: "https://example.test/?password=***&safe=1" },
      message: "password=***&safe=1",
    });
    expect(consoleRecords[5]).toMatchObject({
      payload: "https://example.test/?password=***&safe=1",
      message: "password=***&safe=1",
    });
    expect(records[6].message).toBe("message-only ***");
    expect(consoleRecords[6].message).toBe("message-only ***");
    expect(records[7].message).toBe('derived context {"account":"CONTEX…ALUE"}');
    expect(JSON.stringify([records, consoleRecords, tail.lines])).not.toContain(credential);
  },
);

it.each([false, true])(
  "Gateway plugin service preserves configured JSON-context captures (custom-only=%s)",
  async (customOnly) => {
    vi.stubEnv("OPENCLAW_TEST_FILE_LOG", "1");
    vi.stubEnv("OPENCLAW_TEST_CONSOLE", "1");
    const file = paths.nextPath();
    applyLoggingConfig({
      level: "info",
      file,
      consoleStyle: "json",
      consoleLevel: "info",
      redactPatterns: [
        ...(customOnly ? [] : getDefaultRedactPatterns()),
        String.raw`/"account":"([^"]+)"/g`,
        String.raw`/"customer":"([\s\S]+?)","repeat"/g`,
        String.raw`/"repeat":"repeat-(repeat)"/g`,
        String.raw`/(?<="lookup":")[^"]+/g`,
        String.raw`/"overlap":"(hidden[A-Z]{20})"|hidden/g`,
        String.raw`/secret|[A-Z]{20}/g`,
        "PLAIN_fixture_marker",
      ],
    });
    const output = vi.fn();
    loggingState.rawConsole = { log: output, info: output, warn: output, error: output };
    const logger = createSubsystemLogger("context-record");
    const { api, registry } = registerPlugin(logger, "context-record");
    api.registerService({
      id: "context-record",
      start() {
        logger.info("PLAIN_fixture_marker", {
          scenario: "context",
          account: "private-value",
          customer: 'prefix"\\\n😺\ud800opaque-tail',
          repeat: "repeat-repeat",
          lookup: "opaque-value",
          adjacent: "secretABCDEFGHIJKLMNOPQRST",
          overlap: "hiddenABCDEFGHIJKLMNOPQRST",
          nested: [{ account: "nested-secret" }, { account: ["array-visible"] }],
        });
      },
    });
    const services = await startPluginServices({ registry, config: {} });
    await services.stop();
    await flushLogger();
    const records = fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const consoleRecords = output.mock.calls.map(([line]) => JSON.parse(String(line)));
    const tail = (await readConfiguredLogTail()).lines.map((line) => JSON.parse(line));
    expect(records).toHaveLength(1);
    expect(consoleRecords).toHaveLength(1);
    expect(tail).toHaveLength(1);
    for (const record of [records[0][1], consoleRecords[0], tail[0][1]]) {
      expect(record).toMatchObject({
        scenario: "context",
        account: "***",
        customer: "prefix…tail",
        repeat: "repeat-***",
        lookup: "***",
        adjacent: "***ABCDEF…QRST",
        overlap: "***",
        nested: [{ account: "***" }, { account: ["array-visible"] }],
      });
    }
    expect(records[0].message).toBe("PLAIN_…rker");
    expect(consoleRecords[0].message).toBe("PLAIN_…rker");
    expect(JSON.stringify([records, consoleRecords, tail])).not.toContain("opaque-tail");
  },
);

it.each(patternCases)(
  "Gateway plugin service logger preserves JSONL, credential headers, and pattern reload ($name)",
  async ({ name, custom, patterns }) => {
    const maskedMessage = name === "custom-only" ? '--token "synthe…3456"' : "***";
    vi.stubEnv("OPENCLAW_TEST_FILE_LOG", "1");
    vi.stubEnv("OPENCLAW_TEST_CONSOLE", "1");
    const file = paths.nextPath();
    const config = { level: "info", file, consoleStyle: "json", consoleLevel: "info" } as const;
    applyLoggingConfig({
      ...config,
      ...(patterns ? { redactPatterns: patterns } : {}),
    });
    const output = vi.fn();
    loggingState.rawConsole = { log: output, info: output, warn: output, error: output };
    const logger = createSubsystemLogger("plugins");
    const { api, registry } = registerPlugin(logger, "jsonl-proof");
    const keySecret = "registered-property-name-123456";
    registerSecretValueForRedaction(keySecret);
    let accessorReads = 0;
    const accessor = {
      get toJSON() {
        accessorReads += 1;
        if (accessorReads > 1) {
          throw new Error("toJSON getter read twice");
        }
        return () => ({ message });
      },
    };
    api.registerService({
      id: "jsonl-proof",
      start() {
        api.logger.info(message);
        api.runtime.logging.getChildLogger({ subsystem: "jsonl-proof" }).info(message, {
          nested: [{ message, token: 123456789 }],
          serialized: new (class {
            toJSON() {
              return { message };
            }
          })(),
          boxed: Object.assign(Object(false), { valueOf: () => true }),
          callable: Object.assign(() => undefined, { toJSON: () => message }),
          accessor,
          omitted: Object.fromEntries([["__proto__", () => undefined]]),
          unchanged: 42,
        });
        logger.info("abcd-efgh-ijkl-mnop", {
          token: "opaque-value",
          [keySecret]: true,
          "Proxy-Authorization": "Basic dXNlcjpwYXNz",
          headers,
        });
        api.logger.info("CUSTOM_ONLY_VALUE");
        applyLoggingConfig({ ...config, redactPatterns: ["RELOADED_[A-Z]+"] });
        api.logger.info("CUSTOM_ONLY_VALUE RELOADED_VALUE");
      },
    });
    const services = await startPluginServices({ registry, config: {} });
    await services.stop();
    await flushLogger();
    const raw = fs.readFileSync(file, "utf8");
    const records = raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records).toHaveLength(5);
    expect(records[0]).toMatchObject({
      "1": maskedMessage,
      message: maskedMessage,
    });
    expect(records[1][1]).toEqual({
      nested: [{ message: maskedMessage, token: "***" }],
      serialized: { message: maskedMessage },
      boxed: false,
      callable: maskedMessage,
      accessor: { message: maskedMessage },
      omitted: {},
      unchanged: 42,
    });
    expect(records[2][1]).toMatchObject({
      "Proxy-Authorization": name === "custom-only" ? "Basic …YXNz" : "***",
      headers: maskedHeaders,
    });
    expect(accessorReads).toBe(1);
    expect(raw).not.toContain(token);
    expect(raw).not.toContain(keySecret);
    const consoleRecords = output.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(consoleRecords[0].message).toBe(maskedMessage);
    expect(consoleRecords[1]).toMatchObject({
      token: "***",
      message: "abcd-e…mnop",
      "Proxy-Authorization": name === "custom-only" ? "Basic …YXNz" : "***",
      headers: maskedHeaders,
    });
    expect(JSON.stringify(consoleRecords)).not.toContain(keySecret);
    expect(consoleRecords[2].message).toBe(custom ? "***" : "CUSTOM_ONLY_VALUE");
    expect(consoleRecords[3].message).toBe("CUSTOM_ONLY_VALUE ***");
    expect(records.at(-1).message).toBe("CUSTOM_ONLY_VALUE ***");
    const tail = await readConfiguredLogTail();
    expect(tail.lines.map((line) => JSON.parse(line))).toEqual(records);
  },
);

it("Gateway plugin service logger overflow marker preserves quoted hostname JSONL", async () => {
  vi.stubEnv("OPENCLAW_TEST_FILE_LOG", "1");
  const file = paths.nextPath();
  applyLoggingConfig({ level: "info", file, consoleLevel: "silent" });
  testApi.setHostnameResolverForTests(() => message);
  testApi.setFileLogQueueMaxRecordsForTests(1);
  const { api, registry } = registerPlugin(createSubsystemLogger("plugins"), "overflow-proof");
  api.registerService({
    id: "overflow-proof",
    start() {
      api.logger.info("first");
      api.logger.info("second");
    },
  });
  const services = await startPluginServices({ registry, config: {} });
  await services.stop();
  await flushLogger();
  const records = fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(records).toHaveLength(2);
  expect(records[0]).toMatchObject({
    dropped: 1,
    hostname: "***",
    message: "[openclaw] file log queue overflow; dropped 1 oldest record",
  });
  expect(records[1].message).toBe("second");
});

it.each(patternCases)(
  "Gateway plugin service masks complete long strings, secret fields, and derived messages ($name)",
  async ({ name, patterns }) => {
    const maskedMessage = name === "custom-only" ? '--token "synthe…3456"' : "***";
    vi.stubEnv("OPENCLAW_TEST_FILE_LOG", "1");
    vi.stubEnv("OPENCLAW_TEST_CONSOLE", "1");
    const file = paths.nextPath();
    applyLoggingConfig({
      level: "info",
      file,
      consoleStyle: "json",
      consoleLevel: "info",
      ...(patterns ? { redactPatterns: patterns } : {}),
    });
    const output = vi.fn();
    loggingState.rawConsole = { log: output, info: output, warn: output, error: output };
    const logger = createSubsystemLogger("complete-record");
    const rawLogger = getChildLogger({ subsystem: "complete-record" });
    const { api, registry } = registerPlugin(logger, "complete-record");
    const prefix = `${"x".repeat(16_380)} `;
    const suffix = ` ${"y".repeat(20_000)}`;
    const long = `${prefix}token=${token}${suffix}`;
    const maskedLong = `${prefix}token=synthe…3456${suffix}`;
    const partial = "sk-abcdefghijklmnopqrstuvwxyz0123456789:OPAQUE_REMAINDER";
    let conversions = 0;
    const converted = new (class {
      toJSON() {
        conversions += 1;
        return { token: "OPAQUE_CONVERT_TOKEN", text: message };
      }
    })();
    api.registerService({
      id: "complete-record",
      start() {
        logger.info(long, { scenario: "long", payload: long });
        logger.info("partial fields", {
          scenario: "partial",
          password: partial,
          token: partial,
          Authorization: partial,
          clientSecret: "CUSTOM_ONLY_VALUE OPAQUE_REMAINDER",
          TOKEN: "${TOKEN:-literal-default-secret}",
          session: "$WORKSPACE_DIR/session.jsonl",
        });
        rawLogger.info(undefined, "derived class", converted);
        rawLogger.info(
          new (class {
            toJSON() {
              return { scenario: "first-class", note: "abcd-efgh-ijkl-mnop" };
            }
          })(),
        );
        logger.info("converted console", {
          scenario: "class-console",
          converted: new (class {
            toJSON() {
              return { text: message, token: partial };
            }
          })(),
        });
      },
    });
    const services = await startPluginServices({ registry, config: {} });
    await services.stop();
    await flushLogger();
    const text = fs.readFileSync(file, "utf8");
    const records = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const consoleRecords = output.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(records).toHaveLength(5);
    expect(consoleRecords).toHaveLength(3);
    expect(records[0][1].payload).toBe(maskedLong);
    expect(records[0][2]).toBe(maskedLong);
    expect(consoleRecords[0]).toMatchObject({ message: maskedLong, payload: maskedLong });
    const maskedFields = {
      password: name === "custom-only" ? "sk-abc…NDER" : "***",
      token: name === "custom-only" ? "sk-abc…NDER" : "***",
      Authorization: name === "custom-only" ? "sk-abc…NDER" : "***",
      clientSecret: name === "custom-only" ? "CUSTOM…NDER" : "***",
      TOKEN: "${TOKEN:-***}",
      session: "$WORKSPACE_DIR/session.jsonl",
    };
    expect(records[1][1]).toMatchObject(maskedFields);
    expect(consoleRecords[1]).toMatchObject(maskedFields);
    expect(conversions).toBe(1);
    expect(records[2].message).toBe(
      name === "custom-only"
        ? `derived class ${JSON.stringify({ token: "OPAQUE…OKEN", text: maskedMessage })}`
        : "***",
    );
    expect(records[3].message).toBe('{"scenario":"first-class","note":"abcd-e…mnop"}');
    expect(consoleRecords[2].converted).toEqual({
      text: maskedMessage,
      token: name === "custom-only" ? "sk-abc…NDER" : "***",
    });
    const tail = await readConfiguredLogTail({ maxBytes: 500_000 });
    expect(tail.lines.map((line) => JSON.parse(line))).toHaveLength(5);
    for (const serialized of [text, JSON.stringify(consoleRecords), tail.lines.join("\n")]) {
      expect(serialized).not.toContain(token);
      expect(serialized).not.toContain("OPAQUE_REMAINDER");
      expect(serialized).not.toContain("OPAQUE_CONVERT_TOKEN");
      expect(serialized).not.toContain("abcd-efgh-ijkl-mnop");
    }
  },
);
