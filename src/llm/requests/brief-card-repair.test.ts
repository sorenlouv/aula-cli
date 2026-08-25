import { expect, test } from 'bun:test';
import { briefInput, sourceItem } from '../../testing/brief-fixtures.ts';
import {
  briefCardRepairInstructions,
  briefCardRepairPayload,
  briefCardRepairSchema,
} from './brief-card-repair.ts';

const source = sourceItem({
  key: 'post:photo',
  title: 'Fotodag',
  text: 'Fotodag mandag den 31. august 2026.',
});
const unrelated = sourceItem({ key: 'post:unrelated', title: 'Andet', text: 'Andet indhold.' });
const input = briefInput({ items: [source, unrelated] });
const candidates = [
  {
    cardIndex: 3,
    problem: 'cards[3]: dato uden belæg',
    card: {
      title: 'Fotodag',
      summary: 'Fotodag.',
      children: [],
      date: '2026-09-01',
      recurring: false,
      needsAction: false,
      actionableNow: false,
      reason: 'Relevant.',
      sourceKeys: [source.key],
    },
    sourceKeys: [source.key],
  },
];

test('card repair carries only the rejected card and its current sources', () => {
  const payload = briefCardRepairPayload({ input, candidates });

  expect(payload.repairs).toHaveLength(1);
  expect(payload.repairs[0]?.sources.map((item) => item.sourceKey)).toEqual([source.key]);
  expect(JSON.stringify(payload)).not.toContain(unrelated.key);
});

test('card repair contract pins replacement indexes and the bounded source enum', () => {
  const schema = briefCardRepairSchema({ input, candidates });
  const repair = schema.properties.repairs;

  expect(repair.items.properties.cardIndex.enum).toEqual([3]);
  expect(repair.items.properties.card.properties.sourceKeys.items.enum).toEqual([source.key]);
  expect(briefCardRepairInstructions()).toContain('præcis kortets sourceKeys');
});
