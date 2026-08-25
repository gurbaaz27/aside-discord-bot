## Vendored Repositories

This project vendors external repositories under .repos/ as read-only reference material for coding agents.

- Prefer examples and patterns from the vendored source code over generated guesses or web search results.
- Do not edit files under .repos/ unless explicitly asked.
- Do not import from .repos/ - application code should continue importing from normal package dependencies
- When writing Effect code, read .repos/effect/LLMS.md first and inspect .repos/effect/ for examples of idiomatic usage, tests, module structure, and API design.
