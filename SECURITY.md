# Security policy

Rune Browser runs coding agents, sandboxed apps and web pages next to your
logins and secrets, so security reports are very welcome.

## Reporting a vulnerability

Please **don't open a public issue**. Report it privately through GitHub:
[Report a vulnerability](https://github.com/nayupls1/rune-browser/security/advisories/new)
(the repository's Security tab → "Report a vulnerability").

Include what you found, how to reproduce it, and what an attacker could do with
it. You'll get an answer within a week; fixes for confirmed issues ship in a
release as soon as they're ready, and the advisory is published with it (with
credit, if you like).

## Supported versions

Only the latest release gets security fixes. Rune Browser updates itself, so
staying current is one restart away.

## Scope

Especially interesting:

- An app or a web page escaping its sandbox, or reaching another app's data,
  your files or the network beyond what it was allowed.
- A web page or an app's AI request getting an agent to use tools (see "Rules
  for the product" in [CLAUDE.md](CLAUDE.md): untrusted input never reaches a
  provider that has tools).
- Secret values reaching agents, prompts, logs or API responses.
- Anything that lets an agent bypass a permission prompt.

The agents themselves (Claude Code, Codex, OpenCode) are separate projects;
report their own bugs to them.
