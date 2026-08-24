# Prompt evaluations

Every production LLM request has a named contract under `src/llm/requests/`.
This suite exercises those same exports; it does not carry copies of prompts or
schemas that can drift away from the CLI.

Run everything:

```bash
bun run eval
```

Useful focused runs:

```bash
bun run eval -- --list
bun run eval -- --case personal-calendar-relevance
bun run eval -- --prompt brief-extraction --repeat 3
bun run eval -- --no-model
```

`brief-extraction` cases call the configured model through the production
pipeline, with its cache disabled, and compare editorial decisions rather than
exact generated wording. Repeating a case exposes unstable prompt behaviour.
Reports, including model output, go to gitignored `data/evals/`.

The Google Calendar and Artifact prompts are transport contracts. Their cases
check the exact requested arguments and safety wording without actually calling
Google Calendar or publishing anything. Normal unit tests separately verify
that production rejects missing, additional or changed tool calls.

## Adding cases from real data

1. Capture raw read-only Aula material under gitignored `data/evals/inbox/`.
2. Ask the parent to label the desired decisions while the real situation is
   still recognisable.
3. Replace every person, institution, account, URL, source ID and identifying
   detail with the fictional Eksempelsen family and `eksempel.dk` values.
4. Add the fictional input and its labelled decisions to
   `cases/brief-extraction.ts`.
5. Inspect `git diff` before committing. No raw capture or real-looking family
   data may appear outside `data/`.

An expectation should describe a product decision: which sources become cards
or stay folded, whether an item requires action, whether it can be completed
now, which final section the production ranker places it in, which personal
appointments are relevant, and what is hidden. Only constrain generated wording
when the wording itself is the behaviour being tested. Every required card pins
both `actionableNow` and final `placement`; this keeps ordinary dated obligations
from silently draining into the top action section.
