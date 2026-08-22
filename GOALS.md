# Goals

Who the Aula CLI is for and what it is trying to accomplish. When a trade-off is
open, this decides it.

## The user

A parent of children in day care or primary school. Not highly technical, never
in a terminal, but has an agent harness open — Claude Code Desktop, ChatGPT
desktop — and asks it in Danish or English. The agent translates the request
into a CLI command; only advanced users (the author, say) run the CLI directly.

What reaches the parent may not contain technical jargon. If something breaks,
say what broke and what they should do next. Nothing may require editing a file
by hand.

## Primary purpose: a daily brief good enough to skip Aula

Aula buries what a parent must act on — message threads with teachers, weekly
plans, actions parents must take — in an interface where it is hard to find.
`aula new` generates one overview a parent reads instead of opening Aula. The
brief is the product; everything else supports it.

Ranking is the hard part, not fetching. Aula's own `important` and `unread`
flags are not reliable, so a model reads each item and ranks its relevance on
two signals:

- **Audience.** Addressed to everyone is usually noise; addressed to one class,
  one child or one parent is signal.
- **Subject.** Some broad messages still matter to the individual child —
  sign-up and payment for the yearly school photo, say. Missing one has
  consequences for that child.

**The failure that kills this is silent under-reporting.** A parent who trusts
the brief and misses a deadline is worse off than one who never had it. A
section that could not be fetched must say so, and an empty result that might
be a permissions problem must look different from a quiet day.

## Secondary purpose: ask Aula anything

Any question Aula's APIs can answer should be answerable in natural language.
Aula's frontend calls some 300 methods and this client wraps a dozen, so
wrapping another read endpoint is on-mission by default; `raw` is the escape
hatch until then.

## Not goals

- Writing to Aula. Read-only is a hard requirement, enforced in the transport.
- A nicer Aula client. The win is not opening Aula at all.
- Developer convenience, wherever it conflicts with a parent's clarity.
