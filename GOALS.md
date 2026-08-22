# Goals

Who the Aula CLI is for and what it is trying to be and accomplish. When considering a trade-off, this is what decides it.

## The user

A parent of children in day care or primary school. The user is not highly technical, never uses the terminal, but has installed an agent harness.
They reach this tool through an agent harness they already have open — Claude
Code Desktop, ChatGPT desktop — and ask in Danish or English. The agent runs
the CLI. Only advanced users (like the author of the tool) runs the CLI directly.

The agent translate the user's request into a cli command, in order to query the Aula API.
Responses from the agent to the user may not include technical jargon. If something breaks the response should say what
broke and what the user should do next. Nothing may require editing a file by hand.

## Primary purpose: a daily brief good enough to skip Aula

Aula buries the things a parent must act on in a confusing interface, where the information the user cares about is difficult to find.
The information includes message threads between teachers and parents, weekly plans and important actions that parents must take.
`aula new` generates a single overview a parent reads instead of opening Aula. The brief is the product; everything else supports it.

Ranking is the hard part, not fetching. Aula's own `important` and `unread`
flags are not reliable signals, so a model reads each post and ranks its relevance.
Important signals are:

- audience: information aimed at everyone is often noise; addressed to one class, one child or one parent carries higher signal.
- subject: while information to everyone is often less relevant to the user, some messages with a broad audience are important to surface to the user. Example: sign-up and payment for yearly school photo. Missing this has consequences for the individual child.

**The failure that kills this is silent under-reporting.** A parent who trusts
the brief and misses a deadline is worse off than one who never had it. A
section that could not be fetched must say so, and an empty result that might
be a permissions problem must look different from a quiet day.

## Secondary purpose: ask Aula anything

Any question Aula's APIs can answer should be answerable in natural language. Aula's frontend calls some
300 methods and this client wraps a dozen, so wrapping another read endpoint is
on-mission by default; `raw` is the escape hatch until then.

## Not goals

- Writing to Aula. Read-only is a hard requirement, enforced in the transport.
- A nicer Aula client. The win is not opening Aula at all.
- Developer convenience, wherever it conflicts with a parent's clarity.
