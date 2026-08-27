/**
 * Markdown imported as text.
 *
 * Bun resolves `import x from './f.md' with { type: 'text' }` to the file's
 * contents, and `bun build --compile` embeds those contents in the binary —
 * which is what lets `install-skill` ship the skill template to someone who
 * never cloned the repository. TypeScript has no idea markdown is importable,
 * hence this.
 *
 * The `with { type: 'text' }` attribute is not expressible in a module
 * declaration, so this types the specifier alone; a `.md` import that forgets
 * the attribute still typechecks and then fails at runtime.
 */

declare module '*.md' {
  const contents: string;
  export default contents;
}
