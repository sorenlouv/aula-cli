/** A small, source-bounded repair contract for cards rejected by date grounding. */

import type { BriefInput, SourceItem } from '../../brief/types.ts';
import type { StructuredLlmRequest } from '../request.ts';

export type CardRepairCandidate = {
  cardIndex: number;
  /** The validation message is developer-controlled, never source prose. */
  problem: string;
  /** A schema-shaped snapshot of the one rejected card. */
  card: Record<string, unknown>;
  /** Canonical source keys already accepted for this card. */
  sourceKeys: string[];
};

export type BriefCardRepairInput = {
  input: BriefInput;
  candidates: CardRepairCandidate[];
};

function sourceForRepair(item: SourceItem) {
  return {
    sourceKey: item.key,
    type: item.kind,
    title: item.title,
    writtenAt: item.at,
    text: item.text,
  };
}

/**
 * The full ranking input is intentionally absent. A repair can only inspect
 * the card it is replacing and the sources that already supported that card.
 */
export function briefCardRepairPayload({ input, candidates }: BriefCardRepairInput) {
  const items = new Map(input.items.map((item) => [item.key, item]));
  return {
    today: input.today,
    children: input.family.children.map((child) => child.firstName),
    repairs: candidates.map((candidate) => ({
      cardIndex: candidate.cardIndex,
      rejection: candidate.problem,
      originalCard: candidate.card,
      sources: candidate.sourceKeys.flatMap((key) => {
        const item = items.get(key);
        return item ? [sourceForRepair(item)] : [];
      }),
    })),
  };
}

function repairCardSchema(aulaKeys: string[], firstNames: string[]) {
  const keyEnum = aulaKeys.length > 0 ? { enum: aulaKeys } : { type: 'string' };
  const childEnum = firstNames.length > 0 ? { enum: firstNames } : { type: 'string' };
  return {
    type: 'object',
    properties: {
      title: { type: 'string' },
      summary: { type: 'string' },
      children: { type: 'array', items: childEnum },
      date: { type: ['string', 'null'], format: 'date' },
      recurring: { type: 'boolean' },
      needsAction: { type: 'boolean' },
      actionableNow: { type: 'boolean' },
      reason: { type: 'string' },
      sourceKeys: { type: 'array', minItems: 1, items: keyEnum },
    },
    required: [
      'title',
      'summary',
      'children',
      'date',
      'recurring',
      'needsAction',
      'actionableNow',
      'reason',
      'sourceKeys',
    ],
    additionalProperties: false,
  };
}

export function briefCardRepairSchema({ input, candidates }: BriefCardRepairInput) {
  const sourceKeys = [...new Set(candidates.flatMap((candidate) => candidate.sourceKeys))];
  const indexes = candidates.map((candidate) => candidate.cardIndex);
  const firstNames = input.family.children.map((child) => child.firstName);
  return {
    type: 'object',
    properties: {
      repairs: {
        type: 'array',
        minItems: candidates.length,
        maxItems: candidates.length,
        items: {
          type: 'object',
          properties: {
            cardIndex: { enum: indexes },
            card: repairCardSchema(sourceKeys, firstNames),
          },
          required: ['cardIndex', 'card'],
          additionalProperties: false,
        },
      },
    },
    required: ['repairs'],
    additionalProperties: false,
  };
}

export function briefCardRepairInstructions(): string {
  return `Du reparerer kun et eller flere Aula-kort, som blev afvist, fordi en dato ikke kunne belægges i kortets egne kilder. Hvert repair-objekt indeholder det afviste kort og præcis de kilder, kortet allerede citerede.

Skriv ét helt erstatningskort per cardIndex. Brug ingen andre kilder, og behold præcis kortets sourceKeys. Ret titel, resumé, begrundelse og date, så enhver dato står i disse kilder eller kan regnes ud af deres faste ugedag. Hvis kilderne ikke støtter en dato, er date null og teksten må ikke påstå den. Bevar kun oplysninger, som kilderne støtter. Du ændrer ikke prioriteringen, andre kort eller kalenderaftaler.`;
}

export const briefCardRepairRequest: StructuredLlmRequest<BriefCardRepairInput> = {
  id: 'brief-card-repair',
  instructions: briefCardRepairInstructions,
  payload: briefCardRepairPayload,
  schema: briefCardRepairSchema,
};
