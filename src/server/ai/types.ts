/**
 * The AI gateway's neutral format (R5-4, AIG-01): what every feature speaks, whichever provider answers. Adapters in
 * `providers/` translate it; nothing outside `src/server/ai` knows a provider's own format.
 */

export type AiBlock =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; callId: string; content: string; isError?: boolean };

export interface AiMessage {
  role: "user" | "assistant";
  content: string | AiBlock[];
}

/** A tool the model may ask for, described by a JSON Schema for its input. */
export interface AiTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  /** Ask the provider to keep tool input to the schema exactly, where it supports it. */
  strict?: boolean;
}

export interface AiRequest {
  system: string;
  messages: AiMessage[];
  tools: AiTool[];
  maxOutputTokens: number;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export interface AiResponse {
  /** Why the turn ended: an answer, a request for tools, a refusal, or the output limit. */
  stop: "end" | "tool_calls" | "refusal" | "length";
  /** Text and tool calls. */
  content: AiBlock[];
  usage: AiUsage;
}

/** A provider adapter, ready to call (configured with its model, address and key). */
export interface AiProvider {
  /** The catalogue id (e.g. "ollama"); "scripted" in tests. */
  id: string;
  model: string;
  respond(request: AiRequest, signal: AbortSignal): Promise<AiResponse>;
}

/** A provider failed in a way the gateway explains to people. */
export class ProviderError extends Error {
  constructor(
    readonly kind: "quota" | "auth" | "unavailable" | "bad_request",
    message: string,
    /** From the provider's Retry-After, when it says. */
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
  }
}
