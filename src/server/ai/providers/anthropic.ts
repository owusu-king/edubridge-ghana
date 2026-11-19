import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { ProviderError, type AiBlock, type AiMessage, type AiProvider, type AiResponse } from "../types";

/**
 * Claude through the official SDK (R5-4, AIG-01): kept for when a paid provider is approved (D-R5-6, D-R5-7).
 * Effort `medium`, safety declines routed to a fallback model in the same call, and the tool definitions cached
 * (they are the stable part of every request).
 */

type Param = Anthropic.Beta.Messages.BetaMessageParam;

function toAnthropic(messages: AiMessage[]): Param[] {
  return messages.map((m) => {
    if (typeof m.content === "string") return { role: m.role, content: m.content };
    return {
      role: m.role,
      content: m.content.map((b) =>
        b.type === "text"
          ? { type: "text" as const, text: b.text }
          : b.type === "tool_call"
            ? { type: "tool_use" as const, id: b.id, name: b.name, input: b.input }
            : {
                type: "tool_result" as const,
                tool_use_id: b.callId,
                content: b.content,
                ...(b.isError ? { is_error: true } : {}),
              },
      ),
    } as Param;
  });
}

const clients = new Map<string, Anthropic>();
const client = (apiKey: string) => {
  let c = clients.get(apiKey);
  if (!c) {
    c = new Anthropic({ apiKey });
    clients.clear();
    clients.set(apiKey, c);
  }
  return c;
};

const STOPS: Record<string, AiResponse["stop"]> = {
  end_turn: "end",
  stop_sequence: "end",
  tool_use: "tool_calls",
  max_tokens: "length",
  refusal: "refusal",
};

export function anthropicProvider(options: { model: string; apiKey: string }): AiProvider {
  return {
    id: "anthropic",
    model: options.model,
    async respond(request, signal) {
      try {
        const tools = request.tools.map((t, i) => ({
          name: t.name,
          description: t.description,
          input_schema: t.input_schema as Anthropic.Beta.Messages.BetaTool.InputSchema,
          ...(t.strict ? { strict: true } : {}),
          ...(i === request.tools.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
        }));
        const message = await client(options.apiKey).beta.messages.create(
          {
            model: options.model,
            max_tokens: request.maxOutputTokens,
            system: request.system,
            messages: toAnthropic(request.messages),
            tools,
            output_config: { effort: "medium" },
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
          },
          { signal },
        );
        const content: AiBlock[] = [];
        for (const b of message.content) {
          if (b.type === "text") content.push({ type: "text", text: b.text });
          else if (b.type === "tool_use")
            content.push({ type: "tool_call", id: b.id, name: b.name, input: b.input });
        }
        return {
          stop: STOPS[message.stop_reason ?? "end_turn"] ?? "end",
          content,
          usage: {
            inputTokens:
              (message.usage?.input_tokens ?? 0) +
              (message.usage?.cache_read_input_tokens ?? 0) +
              (message.usage?.cache_creation_input_tokens ?? 0),
            outputTokens: message.usage?.output_tokens ?? 0,
            cachedInputTokens: message.usage?.cache_read_input_tokens ?? 0,
          },
        };
      } catch (error) {
        if (error instanceof Anthropic.RateLimitError) throw new ProviderError("quota", error.message);
        if (
          error instanceof Anthropic.AuthenticationError ||
          error instanceof Anthropic.PermissionDeniedError
        )
          throw new ProviderError("auth", error.message);
        if (error instanceof Anthropic.BadRequestError) throw new ProviderError("bad_request", error.message);
        throw new ProviderError("unavailable", error instanceof Error ? error.message : "Request failed");
      }
    },
  };
}
