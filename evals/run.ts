#!/usr/bin/env bun

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractCards, type ExtractionTelemetry } from '../src/brief/llm.ts';
import { briefExtractionRequest } from '../src/llm/requests/brief-extraction.ts';
import { assertBriefExtraction } from './assert-brief-extraction.ts';
import { briefExtractionCases } from './cases/brief-extraction.ts';
import { staticPromptEvals } from './static-prompts.ts';
import type { EvalFailure } from './types.ts';

type Options = {
  caseId?: string;
  promptId?: string;
  repeat: number;
  list: boolean;
  noModel: boolean;
};

type RunRecord = {
  caseId: string;
  promptId: string;
  iteration: number;
  durationMs: number;
  passed: boolean;
  failures: EvalFailure[];
  telemetry?: ExtractionTelemetry;
  output?: unknown;
  error?: string;
};

function valueAfter(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function parseOptions(args: string[]): Options {
  const repeatRaw = valueAfter(args, '--repeat') ?? '1';
  const repeat = Number.parseInt(repeatRaw, 10);
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20) {
    throw new Error('--repeat skal være et heltal fra 1 til 20');
  }
  const caseId = valueAfter(args, '--case');
  const promptId = valueAfter(args, '--prompt');
  return {
    ...(caseId ? { caseId } : {}),
    ...(promptId ? { promptId } : {}),
    repeat,
    list: args.includes('--list'),
    noModel: args.includes('--no-model'),
  };
}

function selected(id: string, promptId: string, options: Options): boolean {
  return (
    (!options.caseId || options.caseId === id) &&
    (!options.promptId || options.promptId === promptId)
  );
}

function printRecord(record: RunRecord): void {
  const seconds = (record.durationMs / 1000).toFixed(1);
  if (record.passed) {
    console.log(`PASS ${record.promptId}/${record.caseId} #${record.iteration} (${seconds}s)`);
    return;
  }
  console.error(`FAIL ${record.promptId}/${record.caseId} #${record.iteration} (${seconds}s)`);
  for (const failure of record.failures) console.error(`  - ${failure.assertion}`);
  if (record.error) console.error(`  - ${record.error}`);
}

function writeReport(records: RunRecord[]): string {
  const reportDir = join(process.cwd(), 'data', 'evals');
  mkdirSync(reportDir, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(':', '-');
  const path = join(reportDir, `${stamp}.json`);
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        model: process.env.AULA_BRIEF_MODEL ?? null,
        effort: process.env.AULA_BRIEF_EFFORT ?? null,
        records,
      },
      null,
      2,
    )}\n`,
  );
  return path;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2).filter((arg) => arg !== '--'));
  const catalog = [
    ...briefExtractionCases.map((evalCase) => ({
      id: evalCase.id,
      promptId: briefExtractionRequest.id,
      kind: 'model',
      description: evalCase.description,
    })),
    ...staticPromptEvals.map((evalCase) => ({
      id: evalCase.id,
      promptId: evalCase.promptId,
      kind: 'static',
      description: 'Deterministic prompt safety contract.',
    })),
  ];

  if (options.list) {
    for (const item of catalog) {
      console.log(`${item.promptId}/${item.id} [${item.kind}] — ${item.description}`);
    }
    return;
  }

  const records: RunRecord[] = [];
  for (const evalCase of staticPromptEvals) {
    if (!selected(evalCase.id, evalCase.promptId, options)) continue;
    const startedAt = performance.now();
    const failures = evalCase.run();
    const record: RunRecord = {
      caseId: evalCase.id,
      promptId: evalCase.promptId,
      iteration: 1,
      durationMs: performance.now() - startedAt,
      passed: failures.length === 0,
      failures,
    };
    records.push(record);
    printRecord(record);
  }

  if (!options.noModel) {
    for (const evalCase of briefExtractionCases) {
      if (!selected(evalCase.id, briefExtractionRequest.id, options)) continue;
      for (let iteration = 1; iteration <= options.repeat; iteration++) {
        const startedAt = performance.now();
        let record: RunRecord;
        try {
          const output = await extractCards(evalCase.input, { useCache: false });
          const failures = assertBriefExtraction(evalCase, output);
          record = {
            caseId: evalCase.id,
            promptId: briefExtractionRequest.id,
            iteration,
            durationMs: performance.now() - startedAt,
            passed: failures.length === 0,
            failures,
            output,
            ...(output.telemetry ? { telemetry: output.telemetry } : {}),
          };
        } catch (error) {
          record = {
            caseId: evalCase.id,
            promptId: briefExtractionRequest.id,
            iteration,
            durationMs: performance.now() - startedAt,
            passed: false,
            failures: [],
            error: error instanceof Error ? error.message : String(error),
          };
        }
        records.push(record);
        printRecord(record);
      }
    }
  }

  if (records.length === 0) {
    throw new Error('Ingen eval-cases matchede filtrene. Brug --list for at se dem.');
  }

  const passed = records.filter((record) => record.passed).length;
  const reportPath = writeReport(records);
  console.log(`\n${passed}/${records.length} passed. Report: ${reportPath}`);
  if (passed !== records.length) process.exitCode = 1;
}

await main();
