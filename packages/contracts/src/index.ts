import { z } from "zod";

export const ProviderIdSchema = z.enum(["openrouter", "freellmapi"]);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const RouteProfileSchema = z.enum(["fast", "balanced", "quality"]);
export type RouteProfile = z.infer<typeof RouteProfileSchema>;

export const CapabilitySchema = z.enum(["text", "vision", "tools", "json", "streaming", "reasoning"]);
export type Capability = z.infer<typeof CapabilitySchema>;

export const ProviderCapabilitiesSchema = z.object({
  text: z.boolean(),
  vision: z.boolean(),
  tools: z.boolean(),
  json: z.boolean(),
  streaming: z.boolean(),
  reasoning: z.boolean(),
});
export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>;

export const ChatRoleSchema = z.enum(["system", "user", "assistant"]);
export const ChatMessageSchema = z.object({
  role: ChatRoleSchema,
  content: z.string().min(1).max(200_000),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatCompletionRequestSchema = z.object({
  model: z.string().trim().min(1).max(200).default("omni/balanced"),
  messages: z.array(ChatMessageSchema).min(1).max(100),
  max_tokens: z.number().int().min(1).max(8192).optional(),
  temperature: z.number().min(0).max(2).optional(),
  stream: z.boolean().default(false),
}).strict();
export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;

export const ChatCompletionResponseSchema = z.object({
  id: z.string(),
  object: z.literal("chat.completion"),
  created: z.number().int(),
  model: z.string(),
  choices: z.array(z.object({
    index: z.number().int(),
    message: z.object({
      role: z.literal("assistant"),
      content: z.string(),
    }),
    finish_reason: z.enum(["stop", "length", "content_filter"]),
  })).min(1),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative().optional(),
    completion_tokens: z.number().int().nonnegative().optional(),
    total_tokens: z.number().int().nonnegative().optional(),
  }).optional(),
});
export type ChatCompletionResponse = z.infer<typeof ChatCompletionResponseSchema>;

export const ProviderStatusSchema = z.object({
  id: ProviderIdSchema,
  name: z.string(),
  configured: z.boolean(),
  defaultModel: z.string().optional(),
  capabilityNotes: z.array(z.string()),
  capabilities: ProviderCapabilitiesSchema.optional(),
});
export type ProviderStatus = z.infer<typeof ProviderStatusSchema>;

export const PublicConfigSchema = z.object({
  appName: z.literal("Kuro-chan"),
  version: z.string(),
  router: z.object({
    name: z.literal("OmniRouter"),
    availableProfiles: z.array(RouteProfileSchema),
  }),
  providers: z.array(ProviderStatusSchema),
});
export type PublicConfig = z.infer<typeof PublicConfigSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean().default(false),
    requestId: z.string().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const RunStatusSchema = z.enum([
  "queued", "planning", "running", "waiting_for_approval", "verifying",
  "completed", "failed", "cancelled",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const TaskStatusSchema = z.enum([
  "pending", "ready", "running", "waiting_for_approval", "succeeded", "failed", "cancelled",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
