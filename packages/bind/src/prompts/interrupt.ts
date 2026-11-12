/** A human interrupt queued while the agent worked, headed with who sent it. `userId` must already be free of control characters. */
export function renderInterruptMessage(userId: string, content: string): string {
  return `[Interrupt from user ${userId}]\n${content}`;
}
