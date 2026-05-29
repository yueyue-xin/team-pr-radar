# Team PR Radar

A lightweight PR review brief generator for teams.

It uses GitHub CLI search to find relevant open PRs, classifies their review state, optionally adds AI-powered action insights, and sends a concise brief to Google Chat.

No dashboard. No server. No database. Just a command.

---

## What it does

Team PR Radar helps answer:

- Which PRs are waiting for our team review?
- Which of my PRs are still open and need attention?
- Which PRs I reviewed/commented on may need follow-up?
- What is the likely next action for each PR?

It supports:

- Team review queue via `team-review-requested:<org>/<team>`
- My open PRs via `author:<me>`
- Review follow-up via `reviewed-by:<me>` and `commenter:<me>`
- Stale/urgent detection
- CI state detection
- Draft PR filtering
- Optional AI insights using API keys, custom commands, or logged-in Cursor Agent
- Google Chat dry-run and real send modes

---

## Requirements

- Node.js 20+
- GitHub CLI: `gh`
- Authenticated GitHub/GHE access:

```bash
gh auth login --hostname github.example.com
```

For Cursor Agent AI support, optional:

```bash
cursor agent login
cursor agent status
```

---

## Quick start

```bash
# 1. Generate config and GitHub Actions workflow
npx team-pr-radar init

# 2. Edit config
vim config/pr-radar.yml

# 3. Test locally without sending Google Chat
PR_RADAR_DRY_RUN=true npx team-pr-radar

# 4. Send to Google Chat
GOOGLE_CHAT_WEBHOOK_URL='https://chat.googleapis.com/...' npx team-pr-radar
```

For local development from source:

```bash
PR_RADAR_DRY_RUN=true npx tsx scripts/cli.ts --config=config/pr-radar.yml
```

---

## CLI usage

### Team review queue

```bash
npx team-pr-radar
```

Uses `config/pr-radar.yml` and shows open PRs currently requested from the configured reviewer team(s).

Example GitHub search:

```text
team-review-requested:acme/ui-reviewers
```

---

### My open PRs

```bash
npx team-pr-radar --mine
```

Shows open PRs authored by the current GitHub user in the configured repos.

Example GitHub search:

```text
author:<me>
```

This includes PRs that no longer have pending review requests.

---

### My review follow-ups

```bash
npx team-pr-radar --follow-up
```

Finds open PRs you reviewed or commented on, then flags PRs that may need your attention again.

Current follow-up signals:

- New commits after your last review/comment
- Your previous `CHANGES_REQUESTED` review is still waiting on author action

Example GitHub searches:

```text
reviewed-by:<me>
commenter:<me>
```

---

### Custom config path

```bash
npx team-pr-radar --config=config/my-team.yml
npx team-pr-radar --mine --config=config/my-team.yml
npx team-pr-radar --follow-up --config=config/my-team.yml
```

`--mine` and `--follow-up` are separate modes and cannot be used together.

---

## Configuration

Example `config/pr-radar.yml`:

```yaml
github:
  host: github.example.com
  org: acme
  repos:
    - web-app

filters:
  reviewers:
    include:
      - ui-reviewers
    exclude: []

rules:
  ignore_draft: true
  stale_after_hours: 24
  urgent_after_hours: 48
  max_open_prs_per_repo: 100
  max_prs_in_brief: 8
  max_prs_to_ai_summarize: 5
  include_approved_waiting_merge: true

ai:
  enabled: true
  provider: auto
  model: auto

chat:
  title: Team PR Review Brief
  timezone: America/Los_Angeles
```

### Reviewer filters

Bare reviewer names are treated as team names:

```yaml
filters:
  reviewers:
    include:
      - ui-reviewers
```

Equivalent GitHub search:

```text
team-review-requested:<org>/ui-reviewers
```

You can also be explicit:

```yaml
filters:
  reviewers:
    include:
      - team:ui-reviewers
      - team:acme/ui-reviewers
      - user:some-login
```

---

## PR states

| State | Meaning |
|---|---|
| 🟢 Ready for Review | Review has been requested |
| 🟠 Needs Reviewer | No reviewer is currently requested |
| 🟡 Re-Review Needed | Author pushed after changes were requested |
| 🔴 Author Action Needed | Reviewer requested changes |
| ✅ Approved | Approved and waiting for merge/maintainer action |

Additional flags:

- CI failure / pending state
- Stale PRs
- Urgent PRs
- Draft PRs ignored by default

---

## AI insights

AI is optional. When enabled, Team PR Radar adds structured insights to the top PRs:

```text
AI: High risk · Owner: reviewer · Confidence: 82%
Summary: Remove moment.js from automation-ui; replace with day-js shim.
Next: Reviewers prioritize stale review; author must fix failing CI before merge.
```

AI returns:

- `summary` — what the PR appears to change
- `nextAction` — what should happen next
- `owner` — author, reviewer, maintainer, CI, or unknown
- `risk` — low, medium, high, or unknown
- `confidence` — AI confidence score
- `evidence` — short reasoning hints

### AI provider: auto

Recommended local config:

```yaml
ai:
  enabled: true
  provider: auto
  model: auto
```

Auto mode tries, in order:

1. `ANTHROPIC_API_KEY`
2. `OPENAI_API_KEY`
3. `AI_API_KEY` with `ai.base_url`
4. `AI_COMMAND` or `ai.command`
5. Logged-in Cursor Agent

If Cursor Agent is logged in, no API key is required:

```bash
cursor agent status
```

The tool automatically uses:

```bash
cursor agent -p --mode ask --model auto --trust --output-format text
```

### AI provider: command

Use any local AI CLI that reads prompt from stdin and writes answer to stdout:

```yaml
ai:
  enabled: true
  provider: command
  command: "cursor agent -p --mode ask --model auto --trust --output-format text"
```

Or via environment variable:

```bash
AI_COMMAND="cursor agent -p --mode ask --model auto --trust --output-format text" \
PR_RADAR_DRY_RUN=true \
npx team-pr-radar
```

When AI runs, logs look like:

```text
AI enabled: using Cursor Agent
Generating AI insights for 5 PR(s)...
AI 1/5: automation #34994
AI insights completed: 5 attempted, 5 succeeded, 0 failed.
```

---

## Google Chat

Dry run:

```bash
PR_RADAR_DRY_RUN=true npx team-pr-radar
```

Send for real:

```bash
GOOGLE_CHAT_WEBHOOK_URL='https://chat.googleapis.com/...' npx team-pr-radar
```

---

## GitHub Actions

`npx team-pr-radar init` generates `.github/workflows/pr-radar.yml`.

Example:

```yaml
name: PR Radar

on:
  schedule:
    - cron: '0 10 * * 1-5'
  workflow_dispatch:

jobs:
  pr-radar:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Send PR brief
        run: npx team-pr-radar
        env:
          GOOGLE_CHAT_WEBHOOK_URL: ${{ secrets.GOOGLE_CHAT_WEBHOOK_URL }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

For GitHub Enterprise, ensure your workflow can authenticate to the configured host.

---

## Development

```bash
npm install
npm run typecheck
npm run build

# dry-run message generation
npm run test:message

# source CLI dry-run
PR_RADAR_DRY_RUN=true npx tsx scripts/cli.ts --config=config/pr-radar.yml
```

Useful validation commands:

```bash
# Team queue
PR_RADAR_DRY_RUN=true npx tsx scripts/cli.ts --config=config/pr-radar.yml

# My open PRs
PR_RADAR_DRY_RUN=true npx tsx scripts/cli.ts --mine --config=config/pr-radar.yml

# My review follow-ups
PR_RADAR_DRY_RUN=true npx tsx scripts/cli.ts --follow-up --config=config/pr-radar.yml
```
