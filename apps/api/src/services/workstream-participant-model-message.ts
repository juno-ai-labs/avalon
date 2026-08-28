import { ElicitationSchema } from "@rally/contracts";
import { z } from "zod";
import type { ModelMessage } from "@rally/agent-harness";
import type { Env } from "../env";
import {
  buildAttachmentManifestPart,
  buildAttachmentModelParts,
  type ModelAttachmentSource,
} from "./attachment-model-content";

export interface ParticipantModelProjectionInput {
  author:
    | { type: "human" }
    | {
        type: "external";
        actor: { provider: string; displayName: string; providerUserId: string };
      };
  messageType: string;
  text: string;
  structuredContent: unknown;
  mentions: readonly {
    type: string;
    userId?: string | null | undefined;
    displayName?: string | null | undefined;
  }[];
  attachments: readonly ModelAttachmentSource[];
  includeAttachmentContents: boolean;
}

export function canonicalModelMessageJson(message: ModelMessage): string {
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, nested]) => [key, sort(nested)]));
    }
    return value;
  };
  return JSON.stringify(sort(message));
}

export function participantModelMessageContent(
  text: string,
  mentions: ParticipantModelProjectionInput["mentions"],
): string {
  const people = mentions.flatMap((mention) =>
    mention.type === "person" && mention.userId
      ? [{
          type: "person" as const,
          person_id: mention.userId,
          ...(mention.displayName ? { display_name: mention.displayName } : {}),
        }]
      : []);
  return people.length === 0
    ? text
    : `${text}\n\n<rally_mentions>${JSON.stringify(people)}</rally_mentions>`;
}

export async function projectParticipantModelMessage(
  env: Pick<Env, "PAYLOADS" | "DB" | "IMAGES">,
  input: ParticipantModelProjectionInput,
): Promise<ModelMessage | null> {
  if (input.messageType === "elicitation") {
    return projectElicitationResponseMessage(input.structuredContent);
  }
  if (input.messageType !== "text") return null;
  const content = participantModelMessageContent(input.text, input.mentions);
  if (content.trim().length === 0 && input.attachments.length === 0) return null;
  if (input.author.type === "external") {
    const actor = input.author.actor;
    return {
      role: "user",
      content: [
        `EXTERNALLY ATTRIBUTED ${actor.provider.toLocaleUpperCase()} WORKSPACE MEMBER REQUEST`,
        `Display name: ${actor.displayName}`,
        `Provider member ID: ${actor.providerUserId}`,
        content,
      ].join("\n"),
    };
  }
  if (input.attachments.length === 0) return { role: "user", content };
  const sources = [...input.attachments];
  const parts = input.includeAttachmentContents
    ? await buildAttachmentModelParts(env.PAYLOADS, sources, {
        database: env.DB,
        images: env.IMAGES,
      })
    : [buildAttachmentManifestPart(sources)];
  return {
    role: "user",
    content: [
      ...(content.trim().length > 0 ? [{ type: "text" as const, text: content }] : []),
      ...parts,
    ],
  };
}

export function renderElicitationResponseMessage(row: {
  prompt: string;
  response_type: string;
  options_json: string;
  answer_json: string | null;
}): ModelMessage {
  const answer = row.answer_json === null ? null : JSON.parse(row.answer_json) as unknown;
  const options = z.array(z.object({
    label: z.string(),
    value: z.string(),
    description: z.string().nullable().optional(),
  })).catch([]).parse(JSON.parse(row.options_json));
  const optionsByValue = new Map(options.map((option) => [option.value, option]));
  const values = answer == null ? [] : Array.isArray(answer) ? answer : [answer];
  const response = answer == null
    ? { skipped: true }
    : row.response_type === "text"
      ? { skipped: false, text: String(answer) }
      : {
          skipped: false,
          selections: values.map((value) => {
            const option = optionsByValue.get(String(value));
            return option
              ? { value: String(value), label: option.label, ...(option.description ? { description: option.description } : {}) }
              : { customResponse: String(value) };
          }),
        };
  return {
    role: "user",
    content: [
      "The person responded to Rally's blocking question. Continue the original task using this response.",
      JSON.stringify({ kind: "elicitation_response", question: row.prompt, response }),
    ].join("\n"),
  };
}

export function projectElicitationResponseMessage(structuredContent: unknown): ModelMessage | null {
  const parsed = z.object({
    kind: z.literal("elicitation_response"),
    // The model projection depends only on the answered question and response.
    // Connector-backed elicitation and run keys are deliberately opaque local
    // identities, so validating the unrelated public UUID fields here would
    // reject a valid durable answer before it can enter the persistent loop.
    elicitation: ElicitationSchema.pick({
      prompt: true,
      responseType: true,
      status: true,
      answer: true,
    }).extend({
      // Stored connector options predate the public response DTO requiring an
      // explicit null description. Rendering has always treated it as
      // optional, and the model projection must preserve that durable shape.
      options: z.array(z.object({
        value: z.string(),
        label: z.string(),
        description: z.string().nullable().optional(),
      })),
    }),
  }).safeParse(structuredContent);
  if (!parsed.success || parsed.data.elicitation.status !== "answered") return null;
  const elicitation = parsed.data.elicitation;
  return renderElicitationResponseMessage({
    prompt: elicitation.prompt,
    response_type: elicitation.responseType,
    options_json: JSON.stringify(elicitation.options),
    answer_json: elicitation.answer == null ? null : JSON.stringify(elicitation.answer),
  });
}
