import { describe, expect, it, vi } from "vitest";
import {
  OpenAICompatibleSpeechRuntime,
  SpeechProviderError,
} from "../src/speech.js";

describe("OpenAICompatibleSpeechRuntime", () => {
  it("stays disabled unless an audio endpoint and model are configured", () => {
    const runtime = new OpenAICompatibleSpeechRuntime();
    expect(runtime.isTranscriptionConfigured).toBe(false);
    expect(runtime.isSynthesisConfigured).toBe(false);
    expect(runtime.status.transcription.authenticationConfigured).toBe(false);
    expect(runtime.status.synthesis.authenticationConfigured).toBe(false);
  });

  it("uploads bounded audio to an OpenAI-compatible transcription endpoint and returns text", async () => {
    let uploadedText = "";
    let uploadedType = "";
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://speech.example.test/v1/audio/transcriptions");
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer stt-test-secret");
      expect(init?.signal).toBeDefined();
      const form = init?.body as FormData;
      uploadedText = String(form.get("model"));
      uploadedType = String(form.get("language"));
      const file = form.get("file") as File;
      expect(file.name).toBe("sample.webm");
      expect(file.type).toBe("audio/webm");
      expect(await file.text()).toBe("fake audio bytes");
      return new Response(JSON.stringify({ text: "  Hello from the microphone. " }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const runtime = new OpenAICompatibleSpeechRuntime({
      transcription: {
        baseUrl: "https://speech.example.test/v1",
        apiKey: "stt-test-secret",
        model: "whisper-compatible",
      },
      fetchImpl,
    });
    const result = await runtime.transcribe({
      audio: new TextEncoder().encode("fake audio bytes"),
      filename: "sample.webm",
      contentType: "audio/webm",
      language: "en",
    });
    expect(uploadedText).toBe("whisper-compatible");
    expect(uploadedType).toBe("en");
    expect(result).toMatchObject({ text: "Hello from the microphone.", model: "whisper-compatible" });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(runtime.status)).not.toContain("stt-test-secret");
  });

  it("synthesizes text into bounded audio bytes without exposing upstream keys", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://speech.example.test/v1/audio/speech");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer tts-test-secret");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        model: "voice-model",
        input: "Hello there.",
        voice: "en-jp-female",
        response_format: "wav",
        instructions: "Speak clearly in English with a Japanese accent.",
      });
      return new Response(new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]), {
        status: 200,
        headers: { "content-type": "audio/wav" },
      });
    });
    const runtime = new OpenAICompatibleSpeechRuntime({
      synthesis: {
        baseUrl: "https://speech.example.test/v1",
        apiKey: "tts-test-secret",
        model: "voice-model",
        voice: "en-jp-female",
        responseFormat: "wav",
      },
      fetchImpl,
    });
    const result = await runtime.synthesize({
      text: "Hello there.",
      instructions: "Speak clearly in English with a Japanese accent.",
    });
    expect([...result.audio]).toEqual([82, 73, 70, 70, 1, 2, 3, 4]);
    expect(result).toMatchObject({
      contentType: "audio/wav",
      format: "wav",
      model: "voice-model",
    });
    expect(JSON.stringify(runtime.status)).not.toContain("tts-test-secret");
  });

  it("rejects unsupported media, oversized input, and unbounded speech text before the network call", async () => {
    const fetchImpl = vi.fn();
    const runtime = new OpenAICompatibleSpeechRuntime({
      transcription: {
        baseUrl: "https://speech.example.test/v1",
        model: "whisper-compatible",
      },
      synthesis: {
        baseUrl: "https://speech.example.test/v1",
        model: "voice-model",
      },
      fetchImpl,
      maxAudioBytes: 1024,
      maxSpeechTextCharacters: 10,
    });
    await expect(runtime.transcribe({
      audio: new Uint8Array([1, 2, 3]),
      filename: "sample.exe",
      contentType: "application/octet-stream",
    })).rejects.toMatchObject({ code: "invalid_audio" });
    await expect(runtime.transcribe({
      audio: new Uint8Array(1025),
      filename: "sample.wav",
      contentType: "audio/wav",
    })).rejects.toMatchObject({ code: "audio_too_large" });
    await expect(runtime.synthesize({ text: "this text is too long" })).rejects.toMatchObject({
      code: "text_too_large",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails safely on bad upstream responses and does not disclose response body contents", async () => {
    const fetchImpl = vi.fn(async () => new Response("UPSTREAM_SECRET_DATA", { status: 401 }));
    const runtime = new OpenAICompatibleSpeechRuntime({
      synthesis: {
        baseUrl: "https://speech.example.test/v1",
        apiKey: "secret",
        model: "voice-model",
      },
      fetchImpl,
    });
    await expect(runtime.synthesize({ text: "Hello" })).rejects.toMatchObject({
      code: "upstream_rejected",
      message: "Speech service did not accept the configured credentials.",
    });
  });

  it("rejects credential-bearing URLs and requires HTTPS except for loopback", () => {
    expect(() => new OpenAICompatibleSpeechRuntime({
      synthesis: { baseUrl: "https://user:pass@speech.example.test/v1", model: "tts" },
    })).toThrow(SpeechProviderError);
    expect(() => new OpenAICompatibleSpeechRuntime({
      transcription: { baseUrl: "http://speech.example.test/v1", model: "stt" },
    })).toThrow(SpeechProviderError);
    expect(() => new OpenAICompatibleSpeechRuntime({
      transcription: { baseUrl: "http://127.0.0.1:5000/v1", model: "whisper" },
    })).not.toThrow();
  });
});
