# Aula CLI

Read-only client for Aula, the Danish school and daycare platform. It reads
messages, posts, weekly plans, the calendar, photo albums and check-in/check-out
— and nothing else: writing is refused in the transport layer, by design.

It is meant to be driven by an agent. Ask "what did I miss in Aula?" in Claude
Code or Codex and it answers from your own account, and it can generate a daily
overview of what actually needs you.

### Getting started

You need the MitID app on your phone and about ten minutes. Ask your agent:

> Clone https://github.com/sorenlouv/aula-cli to ~/aula-cli and follow its SETUP.md.

Everything it stores — tokens, cache, generated overviews — stays on your
machine unless you turn on publishing yourself.
