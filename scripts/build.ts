#!/usr/bin/env bun
/**
 * `bun run build` — compile the release binaries.
 *
 * The point of this script is that an end user needs neither git nor bun:
 * `bun build --compile` bundles the sources, the dependencies and a Bun
 * runtime into one executable, so installing aula-cli becomes downloading a
 * file and marking it executable.
 *
 * Cross-compiling from any host works because Bun ships the target runtimes;
 * the macOS outputs carry an ad-hoc signature, which is what Apple Silicon
 * requires to run an unsigned binary at all. Files fetched with curl are not
 * quarantined, so no Gatekeeper prompt stands between the download and the
 * first run.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pkg from '../package.json' with { type: 'json' };

type Target = { target: string; out: string };

/**
 * darwin-arm64 first: it is what the overwhelming majority of the audience
 * runs, so a `--target` typo is cheapest to notice there.
 */
const TARGETS: Target[] = [
  { target: 'bun-darwin-arm64', out: 'aula-darwin-arm64' },
  { target: 'bun-darwin-x64', out: 'aula-darwin-x64' },
  { target: 'bun-linux-x64', out: 'aula-linux-x64' },
  { target: 'bun-windows-x64', out: 'aula-windows-x64.exe' },
];

const ROOT = join(import.meta.dir, '..');
const DIST = join(ROOT, 'dist');
const ENTRY = join(ROOT, 'src', 'cli.ts');

function parseTargets(argv: string[]): Target[] {
  const index = argv.indexOf('--target');
  if (index === -1) return TARGETS;
  const wanted = argv[index + 1];
  const found = TARGETS.filter((t) => t.target === wanted || t.out === wanted);
  if (found.length === 0) {
    const names = TARGETS.map((t) => t.target).join('\n  ');
    console.error(`Unknown target ${wanted ?? '(missing)'}. Known targets:\n  ${names}`);
    process.exit(1);
  }
  return found;
}

async function build(target: Target, version: string): Promise<number> {
  const outfile = join(DIST, target.out);
  const proc = Bun.spawn(
    [
      'bun',
      'build',
      '--compile',
      `--target=${target.target}`,
      // Quoted twice on purpose: --define substitutes a source expression, so
      // the value has to arrive as a JS string literal rather than a bare word.
      '--define',
      `BUILD_VERSION=${JSON.stringify(version)}`,
      '--outfile',
      outfile,
      ENTRY,
    ],
    { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' },
  );
  const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) {
    console.error(`  ${target.out}: FAILED\n${err}`);
    return 0;
  }
  return Bun.file(outfile).size;
}

const version = pkg.version;
const targets = parseTargets(process.argv.slice(2));

// A stale binary from a previous run is worse than no binary: it looks like a
// successful build of code that was never compiled.
if (targets.length === TARGETS.length) rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

console.log(`Building aula ${version} → dist/`);
const built: { out: string; size: number }[] = [];
for (const target of targets) {
  const size = await build(target, version);
  if (size === 0) continue;
  built.push({ out: target.out, size });
  console.log(`  ${target.out.padEnd(24)} ${(size / 1_000_000).toFixed(0)} MB`);
}

if (built.length !== targets.length) {
  console.error(`\n${targets.length - built.length} target(s) failed.`);
  process.exit(1);
}

// The checksum file is what a cautious user verifies a download against, and
// what the release workflow publishes alongside the binaries.
const sums = await Promise.all(
  built.map(async ({ out }) => {
    const bytes = await Bun.file(join(DIST, out)).arrayBuffer();
    const digest = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
    return `${digest}  ${out}`;
  }),
);
writeFileSync(join(DIST, 'SHA256SUMS'), `${sums.join('\n')}\n`, 'utf8');
console.log(`\n${built.length} binaries and SHA256SUMS in dist/`);
