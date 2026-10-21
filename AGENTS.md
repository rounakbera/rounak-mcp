# AGENTS.md

Guidelines for humans and AI agents working in this repo. See [README.md](README.md) for what the
server does, its layout and its security model.

## Principles

- **Keep it simple.** Prefer the smallest change that works. No speculative abstractions, no
  frameworks, no build step. Plain ESM JavaScript on Node >= 22.
- **Match the surrounding code**: its naming, comment density and idiom.
- **Security first.** This server holds access to personal mail. When in doubt, choose the more
  restrictive option and ask.

## Commands

```bash
npm install        # also turns on the pre-commit secret check (.githooks/)
npm test           # end-to-end tests; must pass before every PR
npm start          # run the server (needs a filled-in .env)
npm run link       # link a Google account (host machine only)
```

## Workflow

1. Branch from `main` (`feat/…`, `fix/…`, `chore/…`, `docs/…`). Never commit to `main` directly;
   it's protected and only accepts pull requests.
2. Keep each PR to one focused change. Update README.md, `.env.example` and tests in the same PR
   when behaviour, config or tools change.
3. CI (`npm test`, `npm audit`, tracked-secret check) must pass.
4. Merge with **squash merge** only. The PR title becomes the commit message, so write it in the
   imperative ("Add calendar module"). The branch is deleted on merge.

## Secrets (never committed)

- Real values live only in `.env` and `data/`, both git-ignored. `.env.example` holds placeholders
  (`REPLACE_ME`) and is the only env file that's tracked.
- Never put real tokens, keys, emails, domains or other deployment-specific values in code, tests,
  docs, commit messages or PR text. Use `example.com` addresses in tests.
- Never log secrets, tokens, OAuth codes or query strings.
- Don't bypass the pre-commit hook (`--no-verify`). If it flags something, remove the secret.
- If a secret is ever committed or pushed: **rotate it first**, then clean history. Removing the
  file alone isn't enough.

## Dependencies

- Minimal by default. Use Node built-ins (`fetch`, `node:crypto`, `node:test`, …) first.
- Add a dependency only when it's truly necessary, and verify it first: it's actively maintained,
  widely used, has few transitive deps, a clean `npm audit`, and is the real package (not a typosquat).
  Say why it's needed in the PR description.
- Commit `package-lock.json`. Use `npm ci` in automation.
- GitHub Actions are pinned to full commit SHAs.

## Code and tests

- New tools go in a module under `src/modules/` (see README "Modules"), prefixed with the module name,
  with accurate `readOnlyHint` / `destructiveHint` annotations.
- Validate all tool input with `zod`, and encode anything placed into URLs or headers.
- Tests are end-to-end against the real app and MCP SDK client. The only fake is
  `test/helpers/fake-google.js`; don't add mocks of our own code.
- Security-relevant changes (auth, network, storage) need a test in `test/security.test.js`.
