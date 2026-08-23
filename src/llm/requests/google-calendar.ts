import type { ToolLlmRequest } from '../request.ts';

export type GoogleCalendarToolInput = {
  instruction: string;
};

/** Exact prompt used to make one connector call; connector prose is ignored. */
export const googleCalendarToolRequest: ToolLlmRequest<GoogleCalendarToolInput> = {
  id: 'google-calendar-tool',
  prompt: ({ instruction }) =>
    [
      instruction,
      'Kald ingen andre værktøjer. Sammenfat ikke svaret.',
      'Svar derefter kun med ordet DONE.',
    ].join('\n'),
};
