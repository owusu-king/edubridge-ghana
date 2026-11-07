import "server-only";
import Anthropic from "@anthropic-ai/sdk";

/**
 * The language model behind the school assistant, behind a small interface so tests (and, later, another
 * provider) can stand in. The default is Claude through the official SDK. It is used only when the
 * deployment turns it on (ASSISTANT_ENABLED=true with Anthropic credentials): sending school data to a
 * model provider is a decision for the founder (paid service and data processing terms).
 */

export type AssistantMessage = Anthropic.Beta.Messages.BetaMessage;
export type AssistantMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
export type AssistantToolDefinition = Anthropic.Beta.Messages.BetaTool;

export interface AssistantModel {
  name: string;
  respond(request: {
    system: string;
    messages: AssistantMessageParam[];
    tools: AssistantToolDefinition[];
  }): Promise<AssistantMessage>;
}

export const ASSISTANT_MODEL_ID = "claude-opus-5-5";

/** Whether the deployment has turned the assistant on. */
export function assistantConfigured(): boolean {
  return process.env.ASSISTANT_ENABLED === "true";
}

let client: Anthropic | null = null;

/** Claude: adaptive thinking (always on for this model) at medium effort, refusals routed to a fallback. */
export function claudeModel(): AssistantModel {
  return {
    name: ASSISTANT_MODEL_ID,
    async respond({ system, messages, tools }) {
      client ??= new Anthropic();
      return client.beta.messages.create({
        model: ASSISTANT_MODEL_ID,
        max_tokens: 16000,
        system,
        messages,
        tools,
        output_config: { effort: "medium" },
        // A safety decline is re-run on a suitable fallback model inside the same call.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
    },
  };
}
