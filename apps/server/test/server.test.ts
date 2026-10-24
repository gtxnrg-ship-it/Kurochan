import { afterEach, describe, expect, it, vi } from "vitest";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { buildServer, validateServerConfiguration } from "../src/server.js";
import {
  CommunitySkillCatalog,
  McpToolRuntime,
  type McpClientAdapter,
  type McpServerConfig,
  type PlanService,
} from "@kurochan/orchestrator";
import { RunStore } from "@kurochan/storage";
import type { ProviderId } from "@kurochan/contracts";
import {
  OpenAICompatibleSpeechRuntime,
  type ChatCompletionInput,
  type ChatCompletionOutput,
  type ChatProvider,
} from "@kurochan/model-gateway";

describe("Kuro-chan API", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("returns a liveness response without provider credentials", async () => {
    app = buildServer({
      env: { HOST: "127.0.0.1", PORT: "8787" },
      logger: false,
      store: new RunStore(":memory:"),
    });
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      service: "kurochan-api",
    });
  });

  it("exposes pinned community packs and honest source availability", async () => {
    app = buildServer({
      env: {},
      logger: false,
      store: new RunStore(":memory:"),
      communitySkills: new CommunitySkillCatalog({
        repositoryRoot: "/path/that/does/not/exist",
      }),
    });
    const response = await app.inject({
      method: "GET",
      url: "/v1/community-packs?q=debugging",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().total).toBe(16);
    expect(response.json().count).toBeGreaterThan(0);
    expect(response.json().data).toContainEqual(
      expect.objectContaining({
        id: "superpowers",
        mode: "vendored-skill-pack",
        pinnedRevision: "2ce8aa15d05bd57213e6f746f953aafb7ded7a8b",
        skillCatalog: {
          packId: "superpowers",
          available: false,
          skillCount: 0,
        },
      }),
    );
    expect(response.json().security).toMatchObject({
      thirdPartyCodeAutoExecuted: false,
      skillInstructionsAreUntrusted: true,
    });
  });

  it("returns prebuilt MCP configuration templates without secrets or auto-installation", async () => {
    app = buildServer({
      env: {},
      logger: false,
      store: new RunStore(":memory:"),
    });
    const response = await app.inject({
      method: "GET",
      url: "/v1/community-mcp-presets",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().count).toBe(3);
    expect(response.json().data).toContainEqual(
      expect.objectContaining({
        id: "playwright-mcp",
        configuration: expect.objectContaining({
          command: "npx",
          args: ["--yes", "@playwright/mcp@0.0.83"],
        }),
      }),
    );
    expect(response.json().data).toContainEqual(
      expect.objectContaining({
        id: "context7",
        requiredEnvironment: [
          expect.objectContaining({ name: "CONTEXT7_AUTHORIZATION" }),
        ],
      }),
    );
    expect(response.json().security).toMatchObject({
      secretsReturned: false,
      configurationIsTemplate: true,
      serversAreNotAutomaticallyInstalledOrStarted: true,
    });
    expect(response.body).not.toContain("ghp_");
  });

  it("rejects invalid community pack filters", async () => {
    app = buildServer({
      env: {},
      logger: false,
      store: new RunStore(":memory:"),
    });
    const response = await app.inject({
      method: "GET",
      url: "/v1/community-packs?mode=made-up",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "invalid_query" },
    });
  });

  it("searches community skill metadata without returning instruction bodies", async () => {
    const root = await import("node:fs/promises").then(
      ({ mkdtemp, mkdir, writeFile }) =>
        mkdtemp("/tmp/kuro-community-api-").then(async (path) => {
          const skill =
            path + "/vendor/community/superpowers/skills/debugging/SKILL.md";
          await mkdir(skill.slice(0, skill.lastIndexOf("/")), {
            recursive: true,
          });
          await writeFile(
            skill,
            [
              "---",
              "name: Systematic Debugging",
              "description: Debugging and root-cause analysis.",
              "---",
              "# Systematic Debugging",
              "",
              "Never expose this body in the metadata endpoint.",
            ].join("\n"),
            "utf8",
          );
          return { path, skill };
        }),
    );
    try {
      app = buildServer({
        env: {},
        logger: false,
        store: new RunStore(":memory:"),
        communitySkills: new CommunitySkillCatalog({
          repositoryRoot: root.path,
        }),
      });
      const response = await app.inject({
        method: "GET",
        url: "/v1/community-skills?q=debugging",
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain("Never expose this body");
      expect(response.json().data).toContainEqual(
        expect.objectContaining({
          name: "Systematic Debugging",
          packId: "superpowers",
        }),
      );
    } finally {
      const { rm } = await import("node:fs/promises");
      await rm(root.path, { recursive: true, force: true });
    }
  });

  it("does not report ready when no provider is configured", async () => {
    app = buildServer({
      env: {},
      logger: false,
      store: new RunStore(":memory:"),
    });
    const response = await app.inject({ method: "GET", url: "/readyz" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      ready: false,
      configuredProviders: 0,
    });
  });

  it("provides public, secret-free provider configuration", async () => {
    app = buildServer({
      env: {
        OPENROUTER_API_KEY: "top-secret",
        OPENROUTER_MODEL: "configured-model",
      },
      logger: false,
      store: new RunStore(":memory:"),
    });
    const response = await app.inject({ method: "GET", url: "/v1/config" });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("top-secret");
    expect(response.json().providers).toContainEqual(
      expect.objectContaining({ id: "openrouter", configured: true }),
    );
  });

  it("exposes durable provider and reported-token usage without leaking credentials", async () => {
    const store = new RunStore(":memory:");
    const now = Date.now();
    store.recordProviderUsage(
      {
        providerId: "freellmapi",
        model: "auto",
        profile: "fast",
        operation: "chat",
        latencyMs: 120,
        outcome: "success",
        usage: { promptTokens: 40, completionTokens: 16 },
      },
      now,
    );
    store.recordProviderUsage(
      {
        providerId: "openrouter",
        model: "test-model",
        profile: "balanced",
        operation: "task",
        latencyMs: 240,
        outcome: "failure",
        errorCode: "rate_limited",
      },
      now + 1,
    );
    app = buildServer({
      env: { FREELLMAPI_API_KEY: "must-not-be-returned" },
      logger: false,
      store,
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/usage?period=24h",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().totals).toMatchObject({
      requests: 2,
      successfulRequests: 1,
      failedRequests: 1,
      requestsWithTokenUsage: 1,
      requestsWithoutTokenUsage: 1,
      promptTokens: 40,
      completionTokens: 16,
      totalTokens: 56,
    });
    expect(response.json().data).toContainEqual(
      expect.objectContaining({
        providerId: "freellmapi",
        model: "auto",
        requests: 1,
        totalTokens: 56,
      }),
    );
    expect(response.body).not.toContain("must-not-be-returned");
    expect(response.json().accountingNote).toContain("not estimated");
  });

  it("rejects unsupported usage windows", async () => {
    app = buildServer({
      env: {},
      logger: false,
      store: new RunStore(":memory:"),
    });
    const response = await app.inject({
      method: "GET",
      url: "/v1/usage?period=forever",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "invalid_usage_period" },
    });
  });

  it("persists conversational replies, replays idempotent messages, and deletes a thread cleanly", async () => {
    const store = new RunStore(":memory:");
    const calls: ChatCompletionInput[] = [];
    const complete = vi.fn(
      async (input: ChatCompletionInput): Promise<ChatCompletionOutput> => {
        calls.push(input);
        return {
          providerId: "freellmapi",
          model: input.model ?? "auto",
          content: "Assistant reply " + calls.length,
          latencyMs: 7,
          usage: { promptTokens: 15, completionTokens: 4, totalTokens: 19 },
        };
      },
    );
    const freellmapi: ChatProvider = {
      id: "freellmapi",
      displayName: "FreeLLMAPI",
      defaultModel: "auto",
      isConfigured: true,
      capabilities: { text: true, streaming: true },
      complete,
    };
    app = buildServer({
      env: {},
      providers: {
        providers: new Map<ProviderId, ChatProvider>([
          ["freellmapi", freellmapi],
        ]),
        statuses: [
          {
            id: "freellmapi",
            name: "FreeLLMAPI",
            configured: true,
            defaultModel: "auto",
            capabilityNotes: [],
            capabilities: {
              text: true,
              vision: false,
              tools: false,
              json: false,
              streaming: true,
              reasoning: false,
            },
          },
        ],
      },
      logger: false,
      store,
    });

    const created = await app.inject({
      method: "POST",
      url: "/v1/conversations",
      payload: { title: "API helper chat" },
    });
    expect(created.statusCode).toBe(201);
    const conversationId = created.json().conversation.id as string;

    const first = await app.inject({
      method: "POST",
      url: `/v1/conversations/${conversationId}/messages`,
      payload: {
        content: "Can you outline a tiny API?",
        clientMessageId: "mobile-turn-001",
        model: "freellmapi/auto",
      },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      userMessage: { role: "user", sequence: 1 },
      assistantMessage: {
        role: "assistant",
        sequence: 2,
        providerId: "freellmapi",
        model: "auto",
        usage: { promptTokens: 15, completionTokens: 4, totalTokens: 19 },
      },
    });

    const replay = await app.inject({
      method: "POST",
      url: `/v1/conversations/${conversationId}/messages`,
      payload: {
        content: "Can you outline a tiny API?",
        clientMessageId: "mobile-turn-001",
        model: "freellmapi/auto",
      },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().idempotentReplay).toBe(true);
    expect(replay.json().assistantMessage.id).toBe(
      first.json().assistantMessage.id,
    );
    expect(complete).toHaveBeenCalledOnce();

    const second = await app.inject({
      method: "POST",
      url: `/v1/conversations/${conversationId}/messages`,
      payload: {
        content: "Now add tests.",
        clientMessageId: "mobile-turn-002",
        model: "freellmapi/auto",
      },
    });
    expect(second.statusCode).toBe(200);
    expect(calls[1]?.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);

    const detail = await app.inject({
      method: "GET",
      url: `/v1/conversations/${conversationId}?messageLimit=20`,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().conversation.messageCount).toBe(4);
    expect(detail.json().messages).toHaveLength(4);

    const list = await app.inject({
      method: "GET",
      url: "/v1/conversations?limit=10",
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toHaveLength(1);

    const removed = await app.inject({
      method: "DELETE",
      url: `/v1/conversations/${conversationId}`,
    });
    expect(removed.statusCode).toBe(200);
    const missing = await app.inject({
      method: "GET",
      url: `/v1/conversations/${conversationId}`,
    });
    expect(missing.statusCode).toBe(404);
  });

  it("streams conversation replies, persists only completed output, and replays the saved reply", async () => {
    const store = new RunStore(":memory:");
    const stream = vi.fn(async () =>
      (async function* () {
        yield { content: "Hello" };
        yield {
          content: " from Kuro-chan.",
          usage: { promptTokens: 8, completionTokens: 5, totalTokens: 13 },
        };
      })(),
    );
    const freellmapi: ChatProvider = {
      id: "freellmapi",
      displayName: "FreeLLMAPI",
      defaultModel: "auto",
      isConfigured: true,
      capabilities: { text: true, streaming: true },
      complete: async (): Promise<ChatCompletionOutput> => ({
        providerId: "freellmapi",
        model: "auto",
        content: "non-streaming fallback",
        latencyMs: 1,
      }),
      stream,
    };
    app = buildServer({
      env: {},
      providers: {
        providers: new Map<ProviderId, ChatProvider>([
          ["freellmapi", freellmapi],
        ]),
        statuses: [
          {
            id: "freellmapi",
            name: "FreeLLMAPI",
            configured: true,
            defaultModel: "auto",
            capabilityNotes: [],
            capabilities: {
              text: true,
              vision: false,
              tools: false,
              json: false,
              streaming: true,
              reasoning: false,
            },
          },
        ],
      },
      logger: false,
      store,
    });
    const created = await app.inject({
      method: "POST",
      url: "/v1/conversations",
      payload: {},
    });
    const conversationId = created.json().conversation.id as string;
    const url = `/v1/conversations/${conversationId}/messages`;
    const payload = {
      content: "Say hello",
      clientMessageId: "streaming-turn-001",
      model: "freellmapi/auto",
      stream: true,
    };

    const response = await app.inject({ method: "POST", url, payload });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain('"content":"Hello"');
    expect(response.body).toContain('"content":" from Kuro-chan."');
    expect(response.body).toContain("data: [DONE]");
    expect(stream).toHaveBeenCalledOnce();

    const history = store.listConversationMessages(conversationId);
    expect(history.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(history[1]).toMatchObject({
      content: "Hello from Kuro-chan.",
      providerId: "freellmapi",
      model: "auto",
      usage: { promptTokens: 8, completionTokens: 5, totalTokens: 13 },
    });

    const replay = await app.inject({ method: "POST", url, payload });
    expect(replay.statusCode).toBe(200);
    expect(replay.headers["content-type"]).toContain("text/event-stream");
    expect(replay.body).toContain('"content":"Hello from Kuro-chan."');
    expect(replay.body).toContain("data: [DONE]");
    expect(stream).toHaveBeenCalledOnce();
    expect(store.listConversationMessages(conversationId)).toHaveLength(2);
  });

  it("starts a coordinated agent run from a conversation and links the run back into chat history", async () => {
    const store = new RunStore(":memory:");
    const plan = {
      createPlan: vi.fn(async () => ({
        summary: "Implement, test, and review the API.",
        tasks: [
          {
            key: "implementation",
            agentId: "game-development/unreal-engine/unreal-world-builder",
            objective: "Implement the requested project changes.",
            dependsOn: [],
          },
        ],
        selectedAgents: [
          {
            id: "game-development/unreal-engine/unreal-world-builder",
            name: "Unreal World Builder",
            division: "game-development",
          },
        ],
        providerId: "freellmapi",
        model: "auto",
        latencyMs: 5,
        attempts: 1,
      })),
    };
    app = buildServer({
      env: {},
      planner: plan as unknown as PlanService,
      logger: false,
      store,
    });
    const created = await app.inject({
      method: "POST",
      url: "/v1/conversations",
      payload: {},
    });
    const conversationId = created.json().conversation.id as string;
    const response = await app.inject({
      method: "POST",
      url: `/v1/conversations/${conversationId}/runs`,
      payload: {
        goal: "Build and verify the requested API",
        profile: "balanced",
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().run.status).toBe("queued");
    expect(response.json().plan.selectedAgents).toHaveLength(1);
    expect(response.json().message).toMatchObject({
      role: "assistant",
      runId: response.json().run.id,
    });
    expect(response.json().message.metadata).toMatchObject({
      kind: "run_started",
      selectedAgents: [
        {
          id: "game-development/unreal-engine/unreal-world-builder",
        },
      ],
    });
    expect(store.getConversation(conversationId)?.messageCount).toBe(1);
    expect(store.getRun(response.json().run.id)?.createdBy).toBe("local");
    expect(plan.createPlan).toHaveBeenCalledOnce();
  });

  it("reports configured speech providers and serves transcription plus audio synthesis", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/audio/transcriptions")) {
        return new Response(
          JSON.stringify({ text: "Hello from the microphone." }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (url.endsWith("/audio/speech")) {
        return new Response(new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]), {
          status: 200,
          headers: { "content-type": "audio/wav" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    const speech = new OpenAICompatibleSpeechRuntime({
      transcription: {
        baseUrl: "https://speech.example.test/v1",
        apiKey: "transcribe-key",
        model: "whisper-compatible",
      },
      synthesis: {
        baseUrl: "https://speech.example.test/v1",
        apiKey: "synthesis-key",
        model: "speech-compatible",
        voice: "en-jp-female",
        responseFormat: "wav",
        instructions: "Speak English naturally with a light Japanese accent.",
      },
      defaultLanguage: "en",
      fetchImpl,
    });
    app = buildServer({
      env: {},
      logger: false,
      store: new RunStore(":memory:"),
      speech,
    });

    const status = await app.inject({
      method: "GET",
      url: "/v1/speech/status",
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      transcription: {
        enabled: true,
        model: "whisper-compatible",
        defaultLanguage: "en",
        authenticationConfigured: true,
      },
      synthesis: {
        enabled: true,
        model: "speech-compatible",
        voice: "en-jp-female",
        format: "wav",
        customInstructionsConfigured: true,
        authenticationConfigured: true,
      },
      voiceTurn: {
        enabled: true,
        mode: "recorded-audio-turn",
        realtimeDuplex: false,
        bargeInInterruption: false,
      },
      security: {
        credentialsInResponses: false,
        arbitraryUrlsAllowed: false,
      },
    });
    expect(status.body).not.toContain("transcribe-key");
    expect(status.body).not.toContain("synthesis-key");

    const boundary = "kuro-voice-boundary";
    const multipartBody = [
      "--" + boundary,
      'Content-Disposition: form-data; name="file"; filename="sample.wav"',
      "Content-Type: audio/wav",
      "",
      "FAKE_AUDIO_PAYLOAD",
      "--" + boundary,
      'Content-Disposition: form-data; name="language"',
      "",
      "en",
      "--" + boundary + "--",
      "",
    ].join("\r\n");
    const transcription = await app.inject({
      method: "POST",
      url: "/v1/audio/transcriptions",
      headers: { "content-type": "multipart/form-data; boundary=" + boundary },
      payload: multipartBody,
    });
    expect(transcription.statusCode).toBe(200);
    expect(transcription.json()).toMatchObject({
      text: "Hello from the microphone.",
      model: "whisper-compatible",
      language: "en",
    });

    const synthesis = await app.inject({
      method: "POST",
      url: "/v1/audio/speech",
      payload: {
        input: "Hello there.",
        voice: "en-jp-female",
        response_format: "wav",
      },
    });
    expect(synthesis.statusCode).toBe(200);
    expect(synthesis.headers["content-type"]).toContain("audio/wav");
    expect([...Buffer.from(synthesis.rawPayload)]).toEqual([
      82, 73, 70, 70, 1, 2, 3, 4,
    ]);
    expect(synthesis.headers["x-speech-model"]).toBe("speech-compatible");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("runs an idempotent speech-to-speech voice turn and serves its persisted audio artifact", async () => {
    const store = new RunStore(":memory:");
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/audio/transcriptions")) {
        return new Response(JSON.stringify({ text: "What is two plus two?" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/audio/speech")) {
        return new Response(new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]), {
          status: 200,
          headers: { "content-type": "audio/wav" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    const speech = new OpenAICompatibleSpeechRuntime({
      transcription: {
        baseUrl: "https://speech.example.test/v1",
        apiKey: "stt-key",
        model: "whisper-compatible",
      },
      synthesis: {
        baseUrl: "https://speech.example.test/v1",
        apiKey: "tts-key",
        model: "speech-compatible",
        voice: "en-jp-female",
        responseFormat: "wav",
        instructions: "Speak English naturally with a light Japanese accent.",
      },
      defaultLanguage: "en",
      fetchImpl,
    });
    const complete = vi.fn(
      async (input: ChatCompletionInput): Promise<ChatCompletionOutput> => {
        expect(input.systemPrompt).toContain("This is a spoken reply.");
        expect(
          input.messages.some(
            (message) => message.content === "What is two plus two?",
          ),
        ).toBe(true);
        return {
          providerId: "freellmapi",
          model: input.model ?? "auto",
          content: "Four.",
          latencyMs: 9,
          usage: { promptTokens: 24, completionTokens: 2, totalTokens: 26 },
        };
      },
    );
    const freellmapi: ChatProvider = {
      id: "freellmapi",
      displayName: "FreeLLMAPI",
      defaultModel: "auto",
      isConfigured: true,
      capabilities: {
        text: true,
        vision: false,
        tools: false,
        json: false,
        streaming: true,
        reasoning: false,
      },
      complete,
    };
    app = buildServer({
      env: {},
      providers: {
        providers: new Map<ProviderId, ChatProvider>([
          ["freellmapi", freellmapi],
        ]),
        statuses: [
          {
            id: "freellmapi",
            name: "FreeLLMAPI",
            configured: true,
            defaultModel: "auto",
            capabilityNotes: [],
            capabilities: {
              text: true,
              vision: false,
              tools: false,
              json: false,
              streaming: true,
              reasoning: false,
            },
          },
        ],
      },
      logger: false,
      store,
      speech,
    });
    const created = await app.inject({
      method: "POST",
      url: "/v1/conversations",
      payload: {},
    });
    const conversationId = created.json().conversation.id as string;
    const boundary = "kuro-voice-turn-boundary";
    const body = (audioText = "FAKE_AUDIO_PAYLOAD") =>
      [
        "--" + boundary,
        'Content-Disposition: form-data; name="file"; filename="speech.wav"',
        "Content-Type: audio/wav",
        "",
        audioText,
        "--" + boundary,
        'Content-Disposition: form-data; name="clientMessageId"',
        "",
        "voice-turn-001",
        "--" + boundary,
        'Content-Disposition: form-data; name="model"',
        "",
        "freellmapi/auto",
        "--" + boundary,
        'Content-Disposition: form-data; name="voice"',
        "",
        "en-jp-female",
        "--" + boundary,
        'Content-Disposition: form-data; name="response_format"',
        "",
        "wav",
        "--" + boundary + "--",
        "",
      ].join("\r\n");
    const url = `/v1/conversations/${conversationId}/voice-turn`;
    const payload = body();
    const headers = {
      "content-type": "multipart/form-data; boundary=" + boundary,
    };

    const first = await app.inject({ method: "POST", url, headers, payload });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      transcript: {
        text: "What is two plus two?",
        model: "whisper-compatible",
        language: "en",
      },
      assistantMessage: {
        role: "assistant",
        content: "Four.",
        providerId: "freellmapi",
        usage: { promptTokens: 24, completionTokens: 2, totalTokens: 26 },
      },
      synthesis: {
        model: "speech-compatible",
        format: "wav",
        contentType: "audio/wav",
      },
      audio: {
        contentType: "audio/wav",
        format: "wav",
        bytes: 8,
      },
      idempotentReplay: false,
    });
    expect(complete).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(store.listConversationMessages(conversationId)).toHaveLength(2);
    const userMessage = store.listConversationMessages(conversationId)[0]!;
    expect(userMessage.metadata).toMatchObject({
      kind: "voice_input",
      voiceInput: { rawAudioPersisted: false },
    });
    expect(
      store.getConversationAudio(
        conversationId,
        first.json().assistantMessage.id,
      ),
    ).toMatchObject({
      contentType: "audio/wav",
      format: "wav",
      bytes: 8,
    });

    const audio = await app.inject({
      method: "GET",
      url: first.json().audio.url,
    });
    expect(audio.statusCode).toBe(200);
    expect(audio.headers["content-type"]).toContain("audio/wav");
    expect([...Buffer.from(audio.rawPayload)]).toEqual([
      82, 73, 70, 70, 1, 2, 3, 4,
    ]);

    const replay = await app.inject({ method: "POST", url, headers, payload });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().idempotentReplay).toBe(true);
    expect(replay.json().synthesis.model).toBe("speech-compatible");
    expect(replay.json().assistantMessage.id).toBe(
      first.json().assistantMessage.id,
    );
    expect(complete).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(store.listConversationMessages(conversationId)).toHaveLength(2);

    const conflict = await app.inject({
      method: "POST",
      url,
      headers,
      payload: body("DIFFERENT_AUDIO_PAYLOAD"),
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("voice_idempotency_conflict");
    expect(complete).toHaveBeenCalledOnce();
  });

  it("reports MCP configuration and can explicitly probe discovered tools", async () => {
    const serverConfig: McpServerConfig = {
      id: "local-utilities",
      name: "Local utilities",
      transport: "stdio",
      command: "node",
      args: ["/opt/trusted-mcp.js"],
    };
    const mcpClient: McpClientAdapter = {
      connect: vi.fn(async () => undefined),
      listTools: vi.fn(async () => ({
        tools: [
          {
            name: "search_notes",
            description: "Search notes without changing them",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
            annotations: { readOnlyHint: true },
          },
        ],
      })),
      callTool: vi.fn(async () => ({ content: [] })),
      close: vi.fn(async () => undefined),
    };
    const mcpTools = new McpToolRuntime({
      servers: [serverConfig],
      connectorFactory: () => mcpClient,
    });
    app = buildServer({
      env: {},
      logger: false,
      store: new RunStore(":memory:"),
      mcpTools,
    });

    const status = await app.inject({ method: "GET", url: "/v1/mcp/status" });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      enabled: true,
      configuredServerCount: 1,
      probed: false,
      security: {
        credentialsInModelContext: false,
        callsWithNoExplicitReadOnlyAnnotationRequireApproval: true,
        serverConfigurationIsModelControlled: false,
      },
      servers: [
        {
          id: "local-utilities",
          transport: "stdio",
          connected: false,
        },
      ],
    });
    expect(mcpClient.connect).not.toHaveBeenCalled();

    const probe = await app.inject({
      method: "GET",
      url: "/v1/mcp/status?probe=true",
    });
    expect(probe.statusCode).toBe(200);
    expect(probe.json()).toMatchObject({
      probed: true,
      discoveredToolCount: 1,
      tools: [
        {
          serverId: "local-utilities",
          name: "search_notes",
          readOnly: true,
        },
      ],
      servers: [{ id: "local-utilities", connected: true, toolCount: 1 }],
    });
    expect(mcpClient.connect).toHaveBeenCalledOnce();
    expect(mcpClient.listTools).toHaveBeenCalledOnce();

    const invalid = await app.inject({
      method: "GET",
      url: "/v1/mcp/status?probe=yes",
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("reports allowlisted GitHub project capabilities without exposing credentials", async () => {
    app = buildServer({
      env: {
        KUROCHAN_GITHUB_TOKEN: "github-secret-must-not-leak",
        KUROCHAN_GITHUB_ALLOWED_REPOSITORIES: "acme/demo",
        KUROCHAN_GITHUB_WRITE_ENABLED: "true",
      },
      logger: false,
      store: new RunStore(":memory:"),
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/research/status",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().githubProject).toMatchObject({
      configured: true,
      publishingEnabled: true,
      repositoryAllowlistConfigured: true,
      requiresExplicitApproval: true,
    });
    expect(response.body).not.toContain("github-secret-must-not-leak");
  });

  it("reports missing FreeLLMAPI configuration without trying to invent a key", async () => {
    app = buildServer({
      env: {},
      logger: false,
      store: new RunStore(":memory:"),
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/providers/freellmapi/test",
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: "provider_not_configured" },
    });
    expect(response.body).not.toContain("freellmapi-test-key");
  });

  it("tests a configured provider using a short request locked to that provider", async () => {
    const calls: Array<ChatCompletionInput> = [];
    const freellmapi: ChatProvider = {
      id: "freellmapi",
      displayName: "FreeLLMAPI",
      defaultModel: "auto",
      isConfigured: true,
      capabilities: { text: true, streaming: true },
      complete: async (
        input: ChatCompletionInput,
      ): Promise<ChatCompletionOutput> => {
        calls.push(input);
        return {
          providerId: "freellmapi",
          model: input.model ?? "auto",
          content: "connected",
          latencyMs: 3,
        };
      },
    };
    app = buildServer({
      env: {},
      providers: {
        providers: new Map<ProviderId, ChatProvider>([
          ["freellmapi", freellmapi],
        ]),
        statuses: [
          {
            id: "freellmapi",
            name: "FreeLLMAPI",
            configured: true,
            defaultModel: "auto",
            capabilityNotes: [],
            capabilities: {
              text: true,
              vision: false,
              tools: false,
              json: false,
              streaming: true,
              reasoning: false,
            },
          },
        ],
      },
      logger: false,
      store: new RunStore(":memory:"),
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/providers/freellmapi/test",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      provider: "freellmapi",
      model: "auto",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.messages).toEqual([
      {
        role: "user",
        content: "Reply with the single word connected.",
      },
    ]);
    expect(response.body).not.toContain("api_key");
  });

  it("cancels upstream inference when the HTTP client disconnects", async () => {
    let signal: AbortSignal | undefined;
    let signalProviderEntered!: () => void;
    const providerEntered = new Promise<void>((resolve) => {
      signalProviderEntered = resolve;
    });
    let signalAborted!: () => void;
    const providerAborted = new Promise<void>((resolve) => {
      signalAborted = resolve;
    });
    const slowProvider: ChatProvider = {
      id: "openrouter",
      displayName: "OpenRouter",
      defaultModel: "test-model",
      isConfigured: true,
      complete: async (input): Promise<ChatCompletionOutput> => {
        signal = input.signal;
        signalProviderEntered();
        return await new Promise<ChatCompletionOutput>((_resolve, reject) => {
          const onAbort = () => {
            signalAborted();
            reject(
              Object.assign(new Error("cancelled"), { code: "cancelled" }),
            );
          };
          if (input.signal?.aborted) onAbort();
          else input.signal?.addEventListener("abort", onAbort, { once: true });
        });
      },
    };
    app = buildServer({
      env: {},
      providers: {
        providers: new Map<ProviderId, ChatProvider>([
          ["openrouter", slowProvider],
        ]),
        statuses: [
          {
            id: "openrouter",
            name: "OpenRouter",
            configured: true,
            defaultModel: "test-model",
            capabilityNotes: [],
          },
        ],
      },
      logger: false,
      store: new RunStore(":memory:"),
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Test API server did not bind to a TCP address.");
    }
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port: (address as AddressInfo).port,
        path: "/v1/chat/completions",
        method: "POST",
        headers: { "content-type": "application/json" },
      },
      (response) => response.resume(),
    );
    request.on("error", () => undefined);
    request.end(
      JSON.stringify({
        model: "omni/balanced",
        messages: [{ role: "user", content: "Wait for cancellation." }],
      }),
    );
    await providerEntered;
    request.destroy();

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const wasAborted = await Promise.race([
      providerAborted.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), 2000);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    expect(wasAborted).toBe(true);
    expect(signal?.aborted).toBe(true);
  });

  it("keeps the configured free router selectable when the upstream model catalog omits it", async () => {
    const provider: ChatProvider = {
      id: "openrouter",
      displayName: "OpenRouter",
      defaultModel: "openrouter/free",
      isConfigured: true,
      complete: async (): Promise<ChatCompletionOutput> => ({
        providerId: "openrouter",
        model: "openrouter/free",
        content: "ok",
        latencyMs: 1,
      }),
      listModels: async () => [
        {
          id: "vendor/other-model",
          name: "Other model",
        },
      ],
    };
    app = buildServer({
      env: {},
      providers: {
        providers: new Map<ProviderId, ChatProvider>([
          ["openrouter", provider],
        ]),
        statuses: [
          {
            id: "openrouter",
            name: "OpenRouter",
            configured: true,
            defaultModel: "openrouter/free",
            capabilityNotes: [],
          },
        ],
      },
      logger: false,
      store: new RunStore(":memory:"),
    });

    const response = await app.inject({ method: "GET", url: "/v1/models" });

    expect(response.statusCode).toBe(200);
    expect(response.json().providers[0].models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "openrouter/free",
          name: "Free Models Router",
          value: "openrouter/openrouter/free",
          isDefault: true,
        }),
        expect.objectContaining({
          id: "vendor/other-model",
          value: "openrouter/vendor/other-model",
          isDefault: false,
        }),
      ]),
    );
    expect(response.json()).toMatchObject({
      object: "list",
      data: expect.arrayContaining([
        {
          id: "openrouter/openrouter/free",
          object: "model",
          owned_by: "openrouter",
        },
        { id: "omni/quality", object: "model", owned_by: "kurochan" },
      ]),
    });
  });

  it("requires an API token when one is configured", async () => {
    app = buildServer({
      env: { KUROCHAN_API_TOKEN: "test-token" },
      logger: false,
      store: new RunStore(":memory:"),
    });
    const response = await app.inject({ method: "GET", url: "/v1/models" });
    expect(response.statusCode).toBe(401);
    const ok = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: "Bearer test-token" },
    });
    expect(ok.statusCode).toBe(200);
  });

  it("validates external bind safety and port configuration", () => {
    expect(() => validateServerConfiguration({ HOST: "0.0.0.0" })).toThrow(
      /KUROCHAN_API_TOKEN/,
    );
    expect(
      validateServerConfiguration({
        HOST: "0.0.0.0",
        KUROCHAN_API_TOKEN: "token",
        PORT: "8080",
      }),
    ).toEqual({ host: "0.0.0.0", port: 8080 });
    expect(() => validateServerConfiguration({ PORT: "90000" })).toThrow(
      /PORT/,
    );
    expect(() => validateServerConfiguration({ PORT: "8787oops" })).toThrow(
      /PORT/,
    );
    expect(() =>
      validateServerConfiguration({
        API_RATE_LIMIT_PER_MINUTE: "60junk",
      }),
    ).toThrow(/API_RATE_LIMIT_PER_MINUTE/);
    expect(() =>
      validateServerConfiguration({
        OMNIROUTER_MAX_CONCURRENT: "24requests",
      }),
    ).toThrow(/OMNIROUTER_MAX_CONCURRENT/);
    expect(() =>
      buildServer({
        env: { OMNIROUTER_MAX_ATTEMPTS: "2attempts" },
        logger: false,
        store: new RunStore(":memory:"),
      }),
    ).toThrow(/integer between/);
  });

  it("reports live and stale worker heartbeats without leaking worker metadata", async () => {
    const store = new RunStore(":memory:");
    const now = Date.now();
    store.recordWorkerHeartbeat(
      "worker-live",
      "busy",
      "task-123",
      { service: "kurochan-worker" },
      now,
    );
    store.recordWorkerHeartbeat(
      "worker-stale",
      "idle",
      undefined,
      { service: "kurochan-worker" },
      now - 60_000,
    );
    app = buildServer({
      env: {},
      logger: false,
      store,
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/workers?staleAfterMs=1000",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().summary).toEqual({ total: 2, active: 1, stale: 1 });
    expect(response.json().data).toContainEqual(
      expect.objectContaining({
        workerId: "worker-live",
        state: "busy",
        currentTaskId: "task-123",
        stale: false,
      }),
    );
    expect(response.json().data).toContainEqual(
      expect.objectContaining({ workerId: "worker-stale", stale: true }),
    );
  });

  it("passes a selected provider model into planning and persists it on the run", async () => {
    const store = new RunStore(":memory:");
    const conversation = store.createConversation({
      title: "Selected model test",
    });
    const planned = {
      intent: "Implement a feature with a selected model",
      summary: "A test plan",
      assumptions: [],
      clarificationRequired: false,
      tasks: [
        {
          key: "implementation",
          agentId: "engineering/implementer",
          objective: "Implement the feature.",
          dependsOn: [],
          maxAttempts: 1,
          approvalRequired: false,
        },
      ],
      selectedAgents: [
        {
          id: "engineering/implementer",
          name: "Engineering Implementer",
          division: "Engineering",
        },
      ],
      providerId: "openrouter",
      model: "openrouter/free",
      latencyMs: 1,
      attempts: 1,
    };
    const createPlan = vi.fn(async () => planned);
    app = buildServer({
      env: {},
      logger: false,
      store,
      planner: { createPlan } as unknown as PlanService,
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/conversations/" + conversation.id + "/runs",
      payload: {
        goal: "Implement a feature",
        profile: "quality",
        model: "openrouter/openrouter/free",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(createPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        goal: "Implement a feature",
        profile: "balanced",
        preferredProvider: "openrouter",
        providerModel: "openrouter/free",
      }),
    );
    expect(response.json().run).toMatchObject({
      profile: "balanced",
      model: "openrouter/openrouter/free",
    });
    expect(store.getRun(response.json().run.id)?.model).toBe(
      "openrouter/openrouter/free",
    );
  });

  it("locks provider-qualified model IDs to the named provider", async () => {
    const calls: Array<{ provider: ProviderId; model?: string }> = [];
    const fakeProvider = (
      id: ProviderId,
      defaultModel: string,
    ): ChatProvider => ({
      id,
      displayName: id,
      defaultModel,
      isConfigured: true,
      complete: async (
        input: ChatCompletionInput,
      ): Promise<ChatCompletionOutput> => {
        calls.push({ provider: id, model: input.model });
        return {
          providerId: id,
          model: input.model ?? defaultModel,
          content: "ok",
          latencyMs: 2,
        };
      },
    });
    const providers = {
      providers: new Map<ProviderId, ChatProvider>([
        ["openrouter", fakeProvider("openrouter", "vendor/default-model")],
        ["freellmapi", fakeProvider("freellmapi", "free-default")],
      ]),
      statuses: [
        {
          id: "openrouter" as const,
          name: "OpenRouter",
          configured: true,
          defaultModel: "vendor/default-model",
          capabilityNotes: [],
        },
        {
          id: "freellmapi" as const,
          name: "FreeLLMAPI",
          configured: true,
          defaultModel: "free-default",
          capabilityNotes: [],
        },
      ],
    };
    app = buildServer({
      env: {},
      providers,
      logger: false,
      store: new RunStore(":memory:"),
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "freellmapi/acme/model-v2",
        messages: [{ role: "user", content: "hello" }],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([{ provider: "freellmapi", model: "acme/model-v2" }]);
    expect(response.headers["x-omnirouter-provider"]).toBe("freellmapi");
  });

  it("accepts auto as the free-first OmniRouter quality alias", async () => {
    const calls: ProviderId[] = [];
    const fakeProvider = (
      id: ProviderId,
      defaultModel: string,
    ): ChatProvider => ({
      id,
      displayName: id,
      defaultModel,
      isConfigured: true,
      complete: async (
        input: ChatCompletionInput,
      ): Promise<ChatCompletionOutput> => {
        calls.push(id);
        return {
          providerId: id,
          model: input.model ?? defaultModel,
          content: "ok",
          latencyMs: 1,
        };
      },
    });
    app = buildServer({
      env: {},
      providers: {
        providers: new Map<ProviderId, ChatProvider>([
          ["openrouter", fakeProvider("openrouter", "openrouter/free")],
          ["freellmapi", fakeProvider("freellmapi", "auto")],
        ]),
        statuses: [
          {
            id: "openrouter",
            name: "OpenRouter",
            configured: true,
            defaultModel: "openrouter/free",
            capabilityNotes: [],
          },
          {
            id: "freellmapi",
            name: "FreeLLMAPI",
            configured: true,
            defaultModel: "auto",
            capabilityNotes: [],
          },
        ],
      },
      logger: false,
      store: new RunStore(":memory:"),
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "auto",
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(calls).toEqual(["freellmapi"]);
    expect(response.headers["x-omnirouter-profile"]).toBe("quality");
  });

  it("rejects unknown model IDs instead of quietly changing route profiles", async () => {
    app = buildServer({
      env: {},
      logger: false,
      store: new RunStore(":memory:"),
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "invented-model",
        messages: [{ role: "user", content: "hello" }],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "unknown_model" } });
  });

  it("validates malformed inference requests before contacting a provider", async () => {
    app = buildServer({
      env: {},
      logger: false,
      store: new RunStore(":memory:"),
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "omni/balanced", messages: [] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "invalid_request" },
    });
  });
  it("rejects manual run plans that reference unknown specialists", async () => {
    const store = new RunStore(":memory:");
    app = buildServer({
      env: {},
      logger: false,
      store,
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/runs",
      payload: {
        goal: "Run an unknown specialist",
        profile: "balanced",
        tasks: [
          {
            key: "unknown",
            agentId: "invented/agent-id",
            objective: "Perform the task.",
          },
        ],
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: { code: "unknown_specialist", retryable: false },
      invalidAgentIds: ["invented/agent-id"],
    });
    expect(store.listRuns()).toHaveLength(0);
  });

  it("creates a run graph, exposes its events, and supports cancellation", async () => {
    app = buildServer({
      env: {},
      logger: false,
      store: new RunStore(":memory:"),
    });
    const created = await app.inject({
      method: "POST",
      url: "/v1/runs",
      payload: {
        goal: "Build a verified project with Bearer ABCDEFGHIJKLMNOPQRSTUVWXYZ",
        profile: "balanced",
        tasks: [
          {
            key: "research",
            agentId: "game-development/unreal-engine/unreal-world-builder",
            objective: "Gather evidence",
          },
          {
            key: "build",
            agentId: "game-development/unreal-engine/unreal-world-builder",
            objective: "Build from evidence",
            dependsOn: ["research"],
          },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    const runId = created.json().run.id as string;
    const createdEvent = created
      .json()
      .events.find(
        (event: { type: string }) => event.type === "run.created",
      ) as {
      payload: { goal: string };
    };
    expect(createdEvent.payload.goal).toContain("[REDACTED_SECRET]");
    expect(createdEvent.payload.goal).not.toContain(
      "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    );
    expect(created.json().tasks).toHaveLength(2);
    expect(
      created
        .json()
        .tasks.some(
          (task: { dependencies: readonly string[] }) =>
            task.dependencies.length === 1,
        ),
    ).toBe(true);
    const events = await app.inject({
      method: "GET",
      url: `/v1/runs/${runId}/events`,
    });
    expect(events.statusCode).toBe(200);
    expect(
      events.json().data.map((event: { type: string }) => event.type),
    ).toContain("run.plan_created");
    const details = await app.inject({
      method: "GET",
      url: `/v1/runs/${runId}`,
    });
    expect(details.statusCode).toBe(200);
    const detailCreatedEvent = details
      .json()
      .events.find(
        (event: { type: string }) => event.type === "run.created",
      ) as {
      payload: { goal: string };
    };
    expect(detailCreatedEvent.payload.goal).toContain("[REDACTED_SECRET]");
    expect(detailCreatedEvent.payload.goal).not.toContain(
      "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    );
    const planEvent = events
      .json()
      .data.find(
        (event: { type: string }) => event.type === "run.plan_created",
      ) as { payload: { taskGraph?: Array<Record<string, unknown>> } };
    expect(planEvent.payload.taskGraph).toEqual([
      {
        key: "research",
        agentId: "game-development/unreal-engine/unreal-world-builder",
        objective: "Gather evidence",
        dependencies: [],
        approvalRequired: false,
      },
      {
        key: "build",
        agentId: "game-development/unreal-engine/unreal-world-builder",
        objective: "Build from evidence",
        dependencies: ["research"],
        approvalRequired: false,
      },
    ]);
    expect(events.body).toContain("[REDACTED_SECRET]");
    expect(events.body).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    const cancelled = await app.inject({
      method: "POST",
      url: `/v1/runs/${runId}/cancel`,
      payload: { reason: "user requested stop" },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().run.status).toBe("cancelled");

    const invalidCursor = await app.inject({
      method: "GET",
      url: `/v1/runs/${runId}/events/stream?afterId=-1`,
    });
    expect(invalidCursor.statusCode).toBe(400);
    expect(invalidCursor.json()).toMatchObject({
      error: { code: "invalid_event_cursor" },
    });

    const stream = await app.inject({
      method: "GET",
      url: `/v1/runs/${runId}/events/stream`,
    });
    expect(stream.statusCode).toBe(200);
    expect(stream.headers["content-type"]).toContain("text/event-stream");
    expect(stream.body).toContain("event: run.plan_created");
    expect(stream.body).toContain("event: run.cancelled");
    expect(stream.body).toContain("event: stream.end");
    expect(stream.body).toContain("[REDACTED_SECRET]");
    expect(stream.body).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZ");

    const priorEvents = events.json().data as Array<{ id: number }>;
    const cursor = Math.max(...priorEvents.map((event) => event.id));
    const resumed = await app.inject({
      method: "GET",
      url: `/v1/runs/${runId}/events/stream`,
      headers: { "last-event-id": String(cursor) },
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.body).not.toContain("event: run.plan_created");
    expect(resumed.body).toContain("event: run.cancelled");
    expect(resumed.body).toContain("event: stream.end");
  });

  it("asks one blocking clarification without creating an executable run", async () => {
    const store = new RunStore(":memory:");
    const question =
      "Should the first version be a web app or a native mobile app?";
    const planner = {
      createPlan: vi.fn(async () => ({
        intent: "Build a lightweight study-planning app.",
        summary: "Confirm the target platform before implementation.",
        assumptions: ["Keep the first version small and easy to use."],
        clarificationRequired: true,
        clarificationQuestion: question,
        tasks: [
          {
            key: "define-mvp",
            agentId: "game-development/unreal-engine/unreal-world-builder",
            objective: "Define a platform-neutral MVP.",
            dependsOn: [],
          },
        ],
        selectedAgents: [
          {
            id: "game-development/unreal-engine/unreal-world-builder",
            name: "Unreal World Builder",
            division: "game-development",
          },
        ],
        providerId: "freellmapi",
        model: "auto",
        latencyMs: 5,
        attempts: 1,
      })),
    };
    app = buildServer({
      env: {},
      planner: planner as unknown as PlanService,
      logger: false,
      store,
    });
    const created = await app.inject({
      method: "POST",
      url: "/v1/conversations",
      payload: {},
    });
    const conversationId = created.json().conversation.id as string;
    const payload = {
      goal: "Make it real",
      profile: "balanced",
    };
    const url = `/v1/conversations/${conversationId}/runs`;

    const response = await app.inject({ method: "POST", url, payload });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "clarification_required",
      clarification: {
        question,
        intent: "Build a lightweight study-planning app.",
      },
    });
    expect(response.json().run).toBeUndefined();
    expect(store.listRuns()).toHaveLength(0);
    expect(store.listConversationMessages(conversationId)).toHaveLength(1);
    expect(store.listConversationMessages(conversationId)[0]?.content).toBe(
      question,
    );

    const planOnly = await app.inject({
      method: "POST",
      url: "/v1/runs/plan",
      payload,
    });
    expect(planOnly.statusCode).toBe(200);
    expect(planOnly.json().status).toBe("clarification_required");
    expect(store.listRuns()).toHaveLength(0);

    const retry = await app.inject({ method: "POST", url, payload });
    expect(retry.statusCode).toBe(200);
    expect(store.listRuns()).toHaveLength(0);
    expect(store.listConversationMessages(conversationId)).toHaveLength(1);
    expect(planner.createPlan).toHaveBeenCalledTimes(3);
  });

  it("exposes catalog metadata and searches agents without exposing full prompts", async () => {
    app = buildServer({
      env: {},
      logger: false,
      store: new RunStore(":memory:"),
    });
    const metadata = await app.inject({
      method: "GET",
      url: "/v1/agents/catalog",
    });
    expect(metadata.statusCode).toBe(200);
    expect(metadata.json().count).toBe(282);
    const searched = await app.inject({
      method: "GET",
      url: "/v1/agents?q=Unreal%20Engine%20world%20builder&limit=10",
    });
    expect(searched.statusCode).toBe(200);
    const completeCatalog = await app.inject({
      method: "GET",
      url: "/v1/agents?limit=500",
    });
    expect(completeCatalog.statusCode).toBe(200);
    expect(completeCatalog.json().data).toHaveLength(282);
    expect(
      new Set(
        completeCatalog.json().data.map((agent: { id: string }) => agent.id),
      ).size,
    ).toBe(282);
    expect(searched.json().data.length).toBeGreaterThan(0);
    expect(JSON.stringify(searched.json())).not.toContain("Core Mission");

    const deeplyNestedAgent = await app.inject({
      method: "GET",
      url: "/v1/agents/game-development/unreal-engine/unreal-world-builder",
    });
    expect(deeplyNestedAgent.statusCode).toBe(200);
    expect(deeplyNestedAgent.json().id).toBe(
      "game-development/unreal-engine/unreal-world-builder",
    );
    expect(deeplyNestedAgent.body).not.toContain("Core Mission");
  });

  it("rejects invalid pagination values with 400 rather than an internal error", async () => {
    app = buildServer({
      env: {},
      logger: false,
      store: new RunStore(":memory:"),
    });
    const response = await app.inject({
      method: "GET",
      url: "/v1/runs?limit=9999",
    });
    expect(response.statusCode).toBe(400);
  });
  it("streams chat completions through the API using provider SSE chunks", async () => {
    const streamingProvider: ChatProvider = {
      id: "openrouter",
      displayName: "Streaming test provider",
      defaultModel: "test-model",
      isConfigured: true,
      capabilities: { text: true, streaming: true },
      complete: async (): Promise<ChatCompletionOutput> => ({
        providerId: "openrouter",
        model: "test-model",
        content: "unused",
        latencyMs: 1,
      }),
      stream: async () =>
        (async function* () {
          yield { content: "hello" };
          yield { content: " mobile" };
        })(),
    };
    app = buildServer({
      env: {},
      providers: {
        providers: new Map<ProviderId, ChatProvider>([
          ["openrouter", streamingProvider],
        ]),
        statuses: [
          {
            id: "openrouter",
            name: "OpenRouter",
            configured: true,
            defaultModel: "test-model",
            capabilityNotes: [],
            capabilities: {
              text: true,
              vision: false,
              tools: false,
              json: false,
              streaming: true,
              reasoning: false,
            },
          },
        ],
      },
      logger: false,
      store: new RunStore(":memory:"),
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "openrouter/test-model",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.headers["x-omnirouter-provider"]).toBe("openrouter");
    expect(response.body).toContain("hello");
    expect(response.body).toContain(" mobile");
    expect(response.body).toContain("[DONE]");
  });

  it("rejects streaming when no configured provider advertises streaming", async () => {
    const ordinaryProvider: ChatProvider = {
      id: "openrouter",
      displayName: "Non-streaming test provider",
      defaultModel: "test-model",
      isConfigured: true,
      capabilities: { text: true, streaming: false },
      complete: async (): Promise<ChatCompletionOutput> => ({
        providerId: "openrouter",
        model: "test-model",
        content: "unused",
        latencyMs: 1,
      }),
    };
    app = buildServer({
      env: {},
      providers: {
        providers: new Map<ProviderId, ChatProvider>([
          ["openrouter", ordinaryProvider],
        ]),
        statuses: [
          {
            id: "openrouter",
            name: "OpenRouter",
            configured: true,
            defaultModel: "test-model",
            capabilityNotes: [],
            capabilities: {
              text: true,
              vision: false,
              tools: false,
              json: false,
              streaming: false,
              reasoning: false,
            },
          },
        ],
      },
      logger: false,
      store: new RunStore(":memory:"),
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "openrouter/test-model",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: "no_provider_available" },
    });
  });
});
