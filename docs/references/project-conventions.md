# Project conventions

- Refer to [markdown-style.md](/docs/references/markdown-style.md) before creating markdowns, root README.md bypass this rule.
- Issue and PR titles follow [commitlint.config.mjs](/commitlint.config.mjs), same as commit headers.
- Always create a GitHub issue for follow-ups, see [issue-tracker.md](/docs/agents/issue-tracker.md). Don't print them to the terminal or leave them as checklists.
- Avoid unit tests. Prove behavior with end-to-end or integration tests that use the product the way users do. Agent-written unit tests lock in code that should change, slow the agent loop and CI, burn tokens, and can look real while testing nothing. See [Sazabi's case for deleting 800k lines of unit tests][sazabi], [e2e as the only test that guards behavior][kunchenguid], [agents writing tests that test nothing][paradite], and ["Write tests. Not too many. Mostly integration."][rauchg]
- Use bun. A change is done when `bun run lint` passes. Fix formatting with `bun run lint:fix`.
- Fail loudly. Don't add catch-all try/catch, default values, or fallback paths that hide errors.
- Read the official docs (Context7 or the vendor's site) before using a tool, library, or API, and follow its documented usage. Don't guess flags, endpoints, or parameters from memory.
- Add a rule here only after an agent gets something wrong, and prefer a hook, lint rule, or CI check over prose.

[sazabi]: https://x.com/shcallaway/status/2106142042405453879
[kunchenguid]: https://x.com/kunchenguid/status/2097035514067272079
[paradite]: https://x.com/paradite_/status/2003796220880511271
[rauchg]: https://x.com/rauchg/status/807626710350839808
