# `data/` — where real family data lives

Everything in this folder **except this file** is gitignored. That is the whole
point of it: this repository is public, and the data it works with is personal
and concerns children, so the two must never meet.

Put here anything that contains *real* Aula content or real family details:

- captured payloads and wire transcripts saved while debugging
- fixtures built from live responses, before they are fictionalised
- personal notes, drafts and reference material
- anything Claude produces on your behalf that mentions your actual family

The committed fixtures and documentation use a deliberately fictional family
(the Eksempelsen family at Eksempelskolen and Børnehuset Eksemplet). If you are
working on this code with Claude and something real-looking needs to be written
down, it goes in this folder — never in `src/`, never in the docs.

## `private-terms.txt`

The list of real names and terms that must never reach a tracked file: the
family first, then health and diagnoses, then the staff, classmates, parents,
institutions, groups and identifiers around them. One term per line, `#` for
comments and section headings.

**Read it before writing any fixture, test, example, doc or commit message**,
and check any name you invent against it — the fictional cast once reused names
that belonged to real people in the class. Maintain it by hand: add a term the
moment a new name enters the family's life, and never move a term out of it
into a tracked file. It lives here, gitignored, because that is the only way a
denylist of real names can exist in a public repo.

Runtime data (tokens, cookies, the response cache, downloaded attachments and
generated briefs) does not live here at all; it lives in `~/.aula`, outside the
repository entirely.
