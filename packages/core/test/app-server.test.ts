import { describe, expect, it, vi } from "vitest";
import { AppServerConnection } from "../src/app-server.js";
import type { IBackend } from "../src/backend.js";

function createBackend(): IBackend {
  return {
    async initialize() {},
    async dispose() {},
    isAlive() {
      return true;
    },
    async createSession() {
      return "session_1";
    },
    async resumeSession(sessionId) {
      return sessionId;
    },
    async forkSession(sessionId) {
      return `${sessionId}_fork`;
    },
    async disposeSession() {},
    async readSessionHistory() {
      return [];
    },
    async setSessionName() {},
    async prompt() {},
    async abort() {},
    async listModels() {
      return [
        {
          id: "model_1",
          model: "gpt-5.4-mini",
          displayName: "GPT-5.4 Mini",
          description: "Fast model",
          hidden: false,
          isDefault: true,
          inputModalities: ["text"],
          supportedReasoningEfforts: ["minimal", "medium"],
          defaultReasoningEffort: "medium",
          supportsPersonality: true,
        },
      ];
    },
    async setModel() {},
    async getCapabilities() {
      return {
        requiresAuth: false,
        supportsImages: false,
        supportsThinking: true,
        supportsParallelTools: false,
        supportedToolTypes: [],
      };
    },
    async respondToElicitation() {},
    onEvent() {
      return {
        dispose() {},
      };
    },
  };
}

describe("AppServerConnection", () => {
  it("rejects requests before initialize", async () => {
    const connection = new AppServerConnection();
    const response = await connection.handleMessage({
      id: 1,
      method: "config/read",
      params: { includeLayers: false },
    });

    expect(response).toEqual({
      id: 1,
      error: {
        code: -32002,
        message: "Not initialized",
      },
    });
  });

  it("initializes once and rejects a second initialize", async () => {
    const connection = new AppServerConnection();

    const first = await connection.handleMessage({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "codapter-test", title: null, version: "0.1.0" },
        capabilities: { experimentalApi: true, optOutNotificationMethods: ["thread/started"] },
      },
    });
    const second = await connection.handleMessage({
      id: 2,
      method: "initialize",
      params: {
        clientInfo: { name: "codapter-test", title: null, version: "0.1.0" },
        capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
      },
    });

    expect(first).toMatchObject({
      id: 1,
      result: {
        userAgent: expect.any(String),
        platformFamily: expect.any(String),
        platformOs: expect.any(String),
      },
    });
    expect(second).toEqual({
      id: 2,
      error: {
        code: -32003,
        message: "Already initialized",
      },
    });
    expect(connection.emitNotification("thread/started", { threadId: "thr_1" })).toBeNull();
  });

  it("tracks the initialized client notification", async () => {
    const connection = new AppServerConnection();
    await connection.handleMessage({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "codapter-test", title: null, version: "0.1.0" },
        capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
      },
    });

    expect(connection.initializedNotificationReceived).toBe(false);
    await connection.handleMessage({ method: "initialized" });
    expect(connection.initializedNotificationReceived).toBe(true);
  });

  it("writes config values and reads them back", async () => {
    const connection = new AppServerConnection();
    await connection.handleMessage({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "codapter-test", title: null, version: "0.1.0" },
        capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
      },
    });

    const writeResponse = await connection.handleMessage({
      id: 2,
      method: "config/value/write",
      params: {
        keyPath: "model",
        value: "gpt-5.4-mini",
        mergeStrategy: "replace",
        expectedVersion: "1",
      },
    });
    const readResponse = await connection.handleMessage({
      id: 3,
      method: "config/read",
      params: { includeLayers: true },
    });

    expect(writeResponse).toMatchObject({
      id: 2,
      result: {
        status: "ok",
        version: "2",
        filePath: expect.any(String),
      },
    });
    expect(readResponse).toMatchObject({
      id: 3,
      result: {
        config: {
          model: "gpt-5.4-mini",
        },
        layers: [
          {
            version: "2",
          },
        ],
      },
    });
  });

  it("returns model/list data from the backend", async () => {
    const connection = new AppServerConnection({ backend: createBackend() });
    await connection.handleMessage({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "codapter-test", title: null, version: "0.1.0" },
        capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
      },
    });

    const response = await connection.handleMessage({
      id: 2,
      method: "model/list",
      params: {},
    });

    expect(response).toEqual({
      id: 2,
      result: {
        data: [
          {
            id: "model_1",
            model: "gpt-5.4-mini",
            upgrade: null,
            upgradeInfo: null,
            availabilityNux: null,
            displayName: "GPT-5.4 Mini",
            description: "Fast model",
            hidden: false,
            supportedReasoningEfforts: ["minimal", "medium"],
            defaultReasoningEffort: "medium",
            inputModalities: ["text"],
            supportsPersonality: true,
            isDefault: true,
          },
        ],
        nextCursor: null,
      },
    });
  });

  it("returns method-not-found and logs unrecognized methods", async () => {
    const warn = vi.fn();
    const connection = new AppServerConnection({ logger: { warn } });
    await connection.handleMessage({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "codapter-test", title: null, version: "0.1.0" },
        capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
      },
    });

    const response = await connection.handleMessage({
      id: 2,
      method: "does/not/exist",
      params: { noisy: true },
    });

    expect(response).toEqual({
      id: 2,
      error: {
        code: -32601,
        message: "Method not found: does/not/exist",
      },
    });
    expect(warn).toHaveBeenCalledWith("Unrecognized RPC method", {
      method: "does/not/exist",
      requestId: 2,
      params: '{"noisy":true}',
    });
  });
});
