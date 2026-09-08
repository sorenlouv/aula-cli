import type { ToolLlmRequest } from '../request.ts';

export type GoogleCalendarToolInput = {
  instruction: string;
};

/**
 * Exact prompt used to make one connector call; connector prose is ignored.
 *
 * The ToolSearch sentence is not decoration. MCP tools are *deferred* in a
 * headless run — the session lists their names and withholds their schemas
 * until ToolSearch is asked for them — so the one call this prompt exists to
 * place is unreachable without a preceding one. "Call no other tools" on its
 * own therefore forbade the only route to the tool it was demanding, and left
 * a model that took it literally answering that it had no such tool. Naming
 * the exception costs a sentence; `attemptTool` still counts only calls to the
 * tool it asked for, so a ToolSearch cannot smuggle anything past it.
 */
export const googleCalendarToolRequest: ToolLlmRequest<GoogleCalendarToolInput> = {
  id: 'google-calendar-tool',
  prompt: ({ instruction }) =>
    [
      'Slå værktøjet op med ToolSearch, hvis det ikke allerede er tilgængeligt.',
      instruction,
      'Kald ingen andre værktøjer end de to. Sammenfat ikke svaret.',
      'Svar derefter kun med ordet DONE.',
    ].join('\n'),
};
