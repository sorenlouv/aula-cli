import { briefCardRepairRequest } from '../src/llm/requests/brief-card-repair.ts';
import { googleCalendarToolRequest } from '../src/llm/requests/google-calendar.ts';
import type { EvalFailure } from './types.ts';

export type StaticPromptEval = {
  id: string;
  promptId: string;
  run(): EvalFailure[];
};

function requireText(
  failures: EvalFailure[],
  prompt: string,
  expected: string,
  assertion: string,
): void {
  if (!prompt.includes(expected)) failures.push({ assertion, actual: prompt });
}

export const staticPromptEvals: StaticPromptEval[] = [
  {
    id: 'brief-card-repair-contract',
    promptId: briefCardRepairRequest.id,
    run: () => {
      const prompt = briefCardRepairRequest.instructions({
        input: {
          today: '2026-08-24',
          isoWeek: '2026-W35',
          windowDays: 60,
          family: { children: [], isSteppedUp: true },
          items: [],
          health: [],
          albums: [],
          preferences: [],
        },
        candidates: [],
      });
      const failures: EvalFailure[] = [];
      requireText(failures, prompt, 'kun et eller flere Aula-kort', 'limits the repair scope');
      requireText(failures, prompt, 'præcis kortets sourceKeys', 'pins existing citations');
      requireText(failures, prompt, 'ændrer ikke prioriteringen', 'forbids re-ranking');
      requireText(
        failures,
        prompt,
        'date null',
        'requires an honest undated card when evidence is absent',
      );
      return failures;
    },
  },
  {
    id: 'google-calendar-exact-tool-call',
    promptId: googleCalendarToolRequest.id,
    run: () => {
      const instruction =
        'Kald list_events med præcis dette JSON-objekt som argument: {"calendarId":"family","pageSize":250}';
      const prompt = googleCalendarToolRequest.prompt({ instruction });
      const failures: EvalFailure[] = [];
      requireText(failures, prompt, instruction, 'preserves the caller-owned tool arguments');
      requireText(failures, prompt, 'Kald ingen andre værktøjer', 'forbids other tools');
      requireText(failures, prompt, 'Sammenfat ikke svaret', 'forbids model summarisation');
      requireText(failures, prompt, 'kun med ordet DONE', 'requires the fixed acknowledgement');
      return failures;
    },
  },
];
