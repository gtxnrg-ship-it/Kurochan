# Speech-to-text and text-to-speech

Kuro-chan's speech gateway uses separate, optional OpenAI-compatible audio endpoints. Configuring an LLM/chat provider does **not** automatically enable audio. Choose a local open-source speech server or another compatible provider, then configure its own base URL, models, and credentials.

## Environment variables

The API and whichever worker handles the interaction should be configured from server-side environment variables:

```dotenv
KUROCHAN_STT_BASE_URL=
KUROCHAN_STT_API_KEY=
KUROCHAN_STT_MODEL=
KUROCHAN_STT_LANGUAGE=en

KUROCHAN_TTS_BASE_URL=
KUROCHAN_TTS_API_KEY=
KUROCHAN_TTS_MODEL=
# Leave voice/style blank until a compatible provider/model is selected.
KUROCHAN_TTS_VOICE=
KUROCHAN_TTS_FORMAT=mp3
KUROCHAN_TTS_INSTRUCTIONS=.

KUROCHAN_SPEECH_MAX_AUDIO_BYTES=26214400
KUROCHAN_SPEECH_MAX_TEXT_CHARACTERS=20000
KUROCHAN_SPEECH_MAX_RESPONSE_BYTES=20971520
```

The blank URL/model values disable that operation. API keys are optional only when the configured local service itself does not require authentication. Kuro-chan does not choose a voice ID or speaking style for you: leave those values blank until the TTS provider/model is selected and evaluated. If the provider requires a voice ID, configure one it explicitly supports. Accent, naturalness, latency, and voice characteristics depend on the model and must be tested rather than promised by a prompt.

For a local service, loopback HTTP is permitted for development. Remote speech endpoints must use HTTPS. Credentials cannot be embedded in base URLs; Kuro-chan never returns secret values from status routes.

## API contract

- `GET /v1/speech/status` reports whether STT/TTS are configured, model IDs and size limits without exposing keys.
- `POST /v1/audio/transcriptions` accepts multipart form data with exactly one `file` and optional `language` and `prompt` fields. Supported file extensions include `.wav`, `.mp3`, `.mp4`, `.m4a`, `.ogg`, `.flac` and `.webm`. Maximum upload size is 25 MiB.
- `POST /v1/audio/speech` accepts JSON `{ "input": "...", "voice": "...", "response_format": "mp3", "instructions": "..." }` and returns binary audio with the upstream audio content type.

The endpoints are protected by Kuro-chan's usual API bearer-token configuration and have additional per-route request-rate limits. Text, upload, timeout and response sizes are bounded. Error responses are sanitized so upstream response bodies and credentials are not copied into client-visible errors.

## Live voice versus uploaded audio

These endpoints provide the bounded audio-to-text and text-to-audio building blocks for a voice experience. They process a complete uploaded recording or a complete synthesis request; they are not themselves a persistent low-latency duplex WebRTC session. Live interruption, turn detection, streaming synthesis, and session lifecycle must be implemented and tested as a separate real-time layer rather than pretending this upload API is real-time.
