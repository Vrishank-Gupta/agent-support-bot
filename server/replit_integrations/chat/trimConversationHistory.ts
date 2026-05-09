/**
 * trimConversationHistory.ts
 * Drop this file into: server/replit_integrations/chat/
 *
 * Caps token growth on long sessions using a rolling window strategy:
 * - Keeps the last N turns verbatim (immediate context the model needs)
 * - Older turns are replaced with a single cached summary line
 *
 * This prevents token counts from growing unbounded across long sessions
 * without losing important session context.
 *
 * Usage (in routes.ts, before the OpenAI call):
 *   import { trimConversationHistory } from "./trimConversationHistory";
 *   chatMessages = trimConversationHistory(chatMessages);
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

const VERBATIM_TURN_COUNT = 6;
const MIN_TURNS_TO_TRIM = 10;

/**
 * Trims conversation history to cap prompt token growth.
 *
 * Strategy:
 * - System message is always kept first, untouched.
 * - If total turns <= MIN_TURNS_TO_TRIM: return as-is.
 * - Otherwise: collapse older turns into a one-line summary, keep last N verbatim.
 */
export function trimConversationHistory(messages: ChatMessage[]): ChatMessage[] {
  const systemMessages = messages.filter((m) => m.role === "system");
  const turns = messages.filter((m) => m.role !== "system");

  if (turns.length <= MIN_TURNS_TO_TRIM) {
    return messages;
  }

  const keepFromIndex = turns.length - VERBATIM_TURN_COUNT;
  const olderTurns = turns.slice(0, keepFromIndex);
  const recentTurns = turns.slice(keepFromIndex);

  const summaryLines = olderTurns
    .map((m) => {
      const role = m.role === "user" ? "Agent" : "Bot";
      const snippet = m.content.replace(/\s+/g, " ").trim().slice(0, 120);
      return `${role}: ${snippet}`;
    })
    .join("\n");

  const summaryMessage: ChatMessage = {
    role: "assistant",
    content:
      `[Earlier conversation summary — ${olderTurns.length} turns]\n` +
      summaryLines,
  };

  return [...systemMessages, summaryMessage, ...recentTurns];
}
