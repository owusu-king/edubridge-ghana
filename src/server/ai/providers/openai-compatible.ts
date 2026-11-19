import "server-only";
import { ProviderError, type AiBlock, type AiMessage, type AiProvider, type AiResponse } from "../types";

/**
 * Any OpenAI-compatible chat API (R5-4, AIG-01): Ollama on our own machine, free hosted tiers such as Groq, or a
 * paid provider later. Plain `fetch`, no SDK, so no new dependency.
 */

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

const text = (blocks: AiBlock[]) =>
  blocks
    .filter((b): b is Extract<AiBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");

/** The neutral messages, as an OpenAI-compatible conversation. */
export function toChatMessages(system: string, messages: AiMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      const calls = m.content.filter(
        (b): b is Extract<AiBlock, { type: "tool_call" }> => b.type === "tool_call",
      );
      out.push({
        role: "assistant",
        content: text(m.content) || null,
        ...(calls.length
          ? {
              tool_calls: calls.map((c) => ({
                id: c.id,
                type: "function" as const,
                function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
              })),
            }
          : {}),
      });
      continue;
    }
    for (const b of m.content) {
      if (b.type === "tool_result")
        out.push({
          role: "tool",
          tool_call_id: b.callId,
          content: b.isError ? `ERROR: ${b.content}` : b.content,
        });
      else if (b.type === "text") out.push({ role: "user", content: b.text });
    }
  }
  return out;
}

function parseArguments(raw: string | undefined): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const STOPS: Record<string, AiResponse["stop"]> = {
  stop: "end",
  tool_calls: "tool_calls",
  function_call: "tool_calls",
  length: "length",
  content_filter: "refusal",
};

interface ChatCompletion {
  choices?: {
    finish_reason?: string;
    message?: {
      content?: string | null;
      tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
    };
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

/** A chat completion, as the neutral response. */
export function fromChatCompletion(body: ChatCompletion): AiResponse {
  const choice = body.choices?.[0];
  const content: AiBlock[] = [];
  if (choice?.message?.content) content.push({ type: "text", text: choice.message.content });
  for (const [i, call] of (choice?.message?.tool_calls ?? []).entries())
    if (call.function?.name)
      content.push({
        type: "tool_call",
        id: call.id ?? `call_${i}`,
        name: call.function.name,
        input: parseArguments(call.function.arguments),
      });
  const hasCalls = content.some((b) => b.type === "tool_call");
  return {
    stop: hasCalls ? "tool_calls" : (STOPS[choice?.finish_reason ?? "stop"] ?? "end"),
    content,
    usage: {
      inputTokens: body.usage?.prompt_tokens ?? 0,
      outputTokens: body.usage?.completion_tokens ?? 0,
      cachedInputTokens: body.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    },
  };
}

export function openAiCompatibleProvider(options: {
  id: string;
  baseUrl: string;
  model: string;
  apiKey: string | null;
}): AiProvider {
  const url = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  return {
    id: options.id,
    model: options.model,
    async respond(request, signal) {
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          signal,
          headers: {
            "content-type": "application/json",
            ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: options.model,
            messages: toChatMessages(request.system, request.messages),
            max_tokens: request.maxOutputTokens,
            ...(request.tools.length
              ? {
                  tools: request.tools.map((t) => ({
                    type: "function",
                    function: { name: t.name, description: t.description, parameters: t.input_schema },
                  })),
                }
              : {}),
          }),
        });
      } catch (error) {
        throw new ProviderError("unavailable", error instanceof Error ? error.message : "Request failed");
      }
      if (!response.ok) {
        const retry = Number(response.headers.get("retry-after"));
        const detail = (await response.text().catch(() => "")).slice(0, 300);
        if (response.status === 429)
          throw new ProviderError(
            "quota",
            `Rate or quota limit: ${detail}`,
            Number.isFinite(retry) && retry > 0 ? retry : null,
          );
        if (response.status === 401 || response.status === 403)
          throw new ProviderError("auth", `Not authorised: ${detail}`);
        if (response.status >= 500)
          throw new ProviderError("unavailable", `Provider error ${response.status}`);
        throw new ProviderError(
          "bad_request",
          `Provider refused the request (${response.status}): ${detail}`,
        );
      }
      return fromChatCompletion((await response.json()) as ChatCompletion);
    },
  };
}
