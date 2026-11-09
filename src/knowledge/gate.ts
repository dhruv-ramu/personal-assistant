/**
 * Cheap pre-check: does any sentence of this message *state* something (as opposed to asking or
 * commanding)? Only then is the memory-extraction part of the schema sent to the model. Questions,
 * commands, and greetings never produce memory, so they skip that cost. Deliberately permissive:
 * a false positive costs tokens; a false negative only skips saving one statement.
 */
const NOT_A_STATEMENT =
  /^(what|whats|what's|when|where|wheres|where's|who|whos|why|how|is|are|am|do|does|did|can|could|would|will|should|please|remind|add|schedule|book|cancel|delete|remove|move|reschedule|call|wake|set|turn|enable|disable|pause|resume|snooze|list|show|tell|give|find|block|plan|check|hold|undo|forget|yes|no|ok|okay|done|thanks|thank|hi|hello|hey|yo|good (morning|night|evening))\b/;

export function statesSomething(text: string): boolean {
  const sentences = text
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return sentences.some((s) => !s.endsWith("?") && s.split(/\s+/).length >= 3 && !NOT_A_STATEMENT.test(s.replace(/^(and|also|oh|so|btw)\s+/, "")));
}
