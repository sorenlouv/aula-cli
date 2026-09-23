/**
 * Writes a brief built from the test fixtures — the fictional Eksempelsen
 * family — to stdout, as a whole document. For driving the hosted Worker under
 * `wrangler dev` without putting a real family's page in front of anyone:
 *
 *   bun scripts/fixture-brief.ts | curl -X PUT --data-binary @- \
 *     -H 'authorization: Bearer <UPLOAD_TOKEN from .dev.vars>' \
 *     http://127.0.0.1:8787/api/brief
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publish } from '../src/brief/publish.ts';
import { renderPage } from '../src/brief/render.ts';
import { briefInput, card, rankedBrief, sourceItem } from '../src/testing/brief-fixtures.ts';

const today = new Date().toISOString().slice(0, 10);
const inDays = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

const items = [
  sourceItem({
    key: 'post:1001',
    title: 'Skolefoto',
    text: 'Husk at tilmelde jeres barn til skolefoto.',
    childNames: ['Alma Eksempelsen'],
    audience: 'institution',
  }),
  sourceItem({
    key: 'thread:2002',
    kind: 'thread',
    title: 'Lejrskole for 2E',
    text: 'Vi tager af sted mandag. Husk regntøj og madpakke.',
    childNames: ['Alma Eksempelsen'],
  }),
  sourceItem({
    key: 'post:3003',
    title: 'Lukkedag i Myretuen',
    text: 'Børnehaven holder lukket fredag.',
    childNames: ['Viggo Eksempelsen'],
  }),
];

const cards = [
  card({
    id: 'model:0',
    title: 'Tilmeld Alma til skolefoto',
    summary: 'Tilmeldingen skal være på plads inden fristen.',
    children: ['Alma'],
    date: inDays(2),
    needsAction: true,
    sourceKeys: ['post:1001'],
  }),
  card({
    id: 'model:1',
    title: 'Lejrskole: regntøj og madpakke mandag',
    summary: 'Kun madpakke mandag; tirsdag sørger skolen for maden.',
    children: ['Alma'],
    date: inDays(4),
    needsAction: true,
    sourceKeys: ['thread:2002'],
  }),
  card({
    id: 'model:2',
    title: 'Myretuen holder lukket fredag',
    summary: 'Viggo skal passes andetsteds.',
    children: ['Viggo'],
    date: inDays(6),
    sourceKeys: ['post:3003'],
  }),
];

const body = renderPage(rankedBrief(briefInput({ today, items }), cards));
const dir = mkdtempSync(join(tmpdir(), 'aula-fixture-brief-'));
try {
  const { document } = await publish(body, { day: today, title: 'Aula AI oversigt', dir });
  process.stdout.write(document);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
