# core/reviewbot — our own review bot

Reads one pull request and answers GO, NO-GO, HOLD or WAIT for its exact head sha, using this project's own rules: cost rules, gate/CI/key-storage files, the JS and CSS size budget, secrets and personal data, tests, generated files, checks. It is the MERGE GATE table, made automatic.

- `rules.ts` is one pure function, `reviewPullRequest(facts)`. No network, no clock.
- `github.ts` reads PR facts through the API and posts one comment (edited in place) plus a `review-bot` commit status. It never checks out or runs the PR's code.
- `render.ts` writes the comment; the hidden marker holds the head sha so an older comment can be told from the current one.
- Run by hand: `GITHUB_TOKEN=... npm run review:bot -- --repo owner/name --pr 63 [--sizes] [--post]` (`--sizes` measures `dist/client` after `npm run build`). By hand the exit code is 0 GO, 1 NO-GO, 3 HOLD or WAIT; with `--post` (CI) it is 0 once the comment is posted. `.github/workflows/review-bot.yml` runs it on every PR from the base branch copy.

HOLD means a person must decide (gate or CI files, key storage, push-scan fixtures, a raised budget, a photo). Nothing in a PR body or comment can clear it. The bot is itself a HOLD path, so changing the rules needs the person.
