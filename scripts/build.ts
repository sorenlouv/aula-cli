#!/usr/bin/env bun
/**
 * `bun run build` — compile the release binaries.
 *
 * The point of this script is that an end user needs neither git nor bun:
 * `bun build --compile` bundles the sources, the dependencies and a Bun
 * runtime into one executable, so installing aula-cli becomes downloading a
 * file and marking it executable.
 *
 * Cross-compiling the Linux and Windows targets from any host works because Bun
 * ships the target runtimes. The macOS ones must be built on macOS, because
 * they have to be re-signed here — see `signAndVerify`. Files fetched with curl
 * are not quarantined, so no Gatekeeper prompt stands between the download and
 * the first run.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
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

const isDarwin = (target: Target) => target.target.startsWith('bun-darwin');

/**
 * Re-sign a macOS binary ad-hoc, and refuse to ship one whose signature does
 * not cover its own bytes.
 *
 * `bun build --compile` writes the payload into the Bun runtime *after* the
 * signature over it was computed, so the output carries a signature that no
 * longer matches the file. macOS validates code pages lazily as they fault in,
 * so whether the kernel notices depends on which pages it happens to check —
 * the same bytes run on the build machine and die with SIGKILL and "Code
 * Signature Invalid" on a user's Mac. That is how v0.3.1 shipped: CI built it,
 * ran it, and published a binary that Apple Silicon refused to start.
 *
 * The two targets are broken differently. darwin-arm64 got an ad-hoc signature
 * whose final partial page was hashed zero-padded to 4096 bytes rather than
 * truncated at codeLimit — one wrong slot; fixed upstream in Bun 1.4.2.
 * darwin-x64 is not re-signed by Bun at all, so it still carries Bun's own
 * Developer ID and hardened runtime over 58 modified pages including the
 * Mach-O header, and is still broken in 1.4.2.
 *
 * Signing ad-hoc replaces both, which also drops the hardened runtime. That
 * only removes restrictions: the entitlements it was lifting (JIT, unsigned
 * executable memory) need no entitlement once nothing is enforcing them.
 *
 * Do not swap the verify for "run the binary" — running it is what failed to
 * catch this. And do not skip it because `codesign --verify` once looked like
 * a false alarm; it was reporting a real defect all along.
 */
async function signAndVerify(outfile: string): Promise<boolean> {
  const steps = [
    ['codesign', '--force', '--sign', '-', '--timestamp=none', outfile],
    ['codesign', '--verify', '--strict', outfile],
  ];
  for (const args of steps) {
    const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });
    const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (code !== 0) {
      console.error(`  ${basename(outfile)}: codesign ${args[1]} FAILED\n${err}`);
      return false;
    }
  }
  return true;
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
  // Before the size is read, and so before SHA256SUMS: signing rewrites the
  // tail of the file, so a checksum taken first would describe a binary that
  // is not the one being published.
  if (isDarwin(target) && !(await signAndVerify(outfile))) return 0;
  return Bun.file(outfile).size;
}

/**
 * The tag wins when there is one.
 *
 * CI sets this from the pushed tag so the binary and the release it is
 * attached to can never disagree — `aula version` reporting 0.1.0 from a
 * release called v0.2.0 is the kind of thing that costs an hour of confusion
 * in a bug report. A local `bun run build` has no tag and uses package.json.
 */
const version = process.env.AULA_BUILD_VERSION?.replace(/^v/, '') || pkg.version;
const targets = parseTargets(process.argv.slice(2));

// `codesign` exists only on macOS, and an unsigned darwin binary is precisely
// the bug this build step exists to prevent — so refuse to produce one rather
// than emit something that looks like a release asset and cannot start. The
// release workflow already builds the darwin targets on a macOS runner.
if (process.platform !== 'darwin' && targets.some(isDarwin)) {
  const names = targets
    .filter(isDarwin)
    .map((t) => t.out)
    .join(', ');
  console.error(
    `The darwin targets must be built on macOS — this is ${process.platform}.\n` +
      `Bun leaves ${names} carrying a signature that does not match the file, and\n` +
      `only codesign can repair that. Build the other targets with --target.`,
  );
  process.exit(1);
}

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
