/**
 * A model request as a first-class contract.
 *
 * Keeping the instructions, payload projection and output schema behind one
 * object gives production and evaluations the same entrypoint. A prompt edit
 * cannot accidentally update the CLI while leaving its benchmark on an older
 * copy.
 */
export type StructuredLlmRequest<Input> = {
  id: string;
  instructions(input: Input): string;
  payload(input: Input): unknown;
  schema(input: Input): unknown;
};

/** A prompt whose desired result is a tool call rather than structured prose. */
export type ToolLlmRequest<Input> = {
  id: string;
  prompt(input: Input): string;
};
