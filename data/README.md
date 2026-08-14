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

Runtime data (tokens, cookies, the response cache, downloaded attachments and
generated briefs) does not live here at all; it lives in `~/.aula`, outside the
repository entirely.
