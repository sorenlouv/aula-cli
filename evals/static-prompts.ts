import { artifactDeployRequest } from '../src/llm/requests/artifact-deploy.ts';
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
  {
    id: 'artifact-create-contract',
    promptId: artifactDeployRequest.id,
    run: () => {
      const prompt = artifactDeployRequest.prompt({
        artifactPath: '/tmp/example.html',
        url: null,
        title: 'Eksempelfamiliens overblik',
      });
      const failures: EvalFailure[] = [];
      requireText(failures, prompt, 'exactly one Artifact tool call', 'requires one tool call');
      requireText(failures, prompt, 'file_path: /tmp/example.html', 'pins the local file');
      requireText(failures, prompt, 'title: Eksempelfamiliens overblik', 'pins the title');
      if (prompt.includes('  url:') || prompt.includes('force: true')) {
        failures.push({ assertion: 'create does not invent an existing target', actual: prompt });
      }
      return failures;
    },
  },
  {
    id: 'artifact-redeploy-contract',
    promptId: artifactDeployRequest.id,
    run: () => {
      const url = 'https://claude.ai/code/artifact/12345678-1234-1234-1234-123456789abc';
      const prompt = artifactDeployRequest.prompt({
        artifactPath: '/tmp/example.html',
        url,
        title: 'Eksempelfamiliens overblik',
      });
      const failures: EvalFailure[] = [];
      requireText(failures, prompt, `url: ${url}`, 'pins the configured target');
      requireText(failures, prompt, 'force: true', 'replaces the prior generated edition');
      requireText(failures, prompt, 'nothing else', 'forbids extra tool inputs');
      return failures;
    },
  },
];
