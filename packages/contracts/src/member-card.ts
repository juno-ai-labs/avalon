import { z } from "zod";

/**
 * The card an agent shows to bring someone into the Organization: their
 * address, and the name it knows them by, if any. An administrator's press
 * adds them as a member at once (`POST /workspace/members`), with nothing for
 * them to accept. It rides on a blocking question (`Elicitation.member`), and
 * the card answers that question for the person who pressed it, so the agent
 * carries on with a member it can ask things of. `docs/workspace-member-roles.md`.
 */
export const MemberCardInputSchema = z.strictObject({
  email: z.string().trim().toLowerCase().email().max(254)
    .describe("The address to add them at, for example nancy@example.com."),
  name: z.string().trim().min(1).max(120).optional()
    .describe("Their name, when you know it, so the card says who they are."),
});
export type MemberCardInput = z.infer<typeof MemberCardInputSchema>;

/** The answer the card sends once the person is a member. The values are what the model reads. */
export const MEMBER_QUESTION_ADDED_ANSWER = "added";
export const MEMBER_QUESTION_OPTIONS = [
  { value: MEMBER_QUESTION_ADDED_ANSWER, label: "Added", description: "They are a member now." },
  { value: "declined", label: "Not now", description: "Do not add them." },
] as const;
