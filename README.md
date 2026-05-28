# Team PR Radar

AI-assisted PR review brief sender for Google Chat. No dashboard, no server, no database — just a single command.

## Quick Start

```bash
# 1. Generate config + GitHub Actions workflow
npx team-pr-radar init

# 2. Edit your config
vim config/pr-radar.yml

# 3. Test locally (dry run)
GOOGLE_CHAT_WEBHOOK_URL='https://chat.googleapis.com/...' \
PR_RADAR_DRY_RUN=true \
npx team-pr-radar

# 4. Send for real
GOOGLE_CHAT_WEBHOOK_URL='https://chat.googleapis.com/...' \
npx team-pr-radar
```

## Config

```yaml
github:
  host: github.com
  org: your-org
  repos:
    - your-repo

filters:
  reviewers:
    include:
      - your-team-name       # filter by requested team/user
  paths:
    include:
      - packages/ui/**       # filter by changed file paths

rules:
  stale_after_hours: 24
  urgent_after_hours: 48
  max_open_prs_per_repo: 100
  max_prs_in_brief: 8

ai:
  enabled: false             # set OPENAI_API_KEY to enable
  model: gpt-4o-mini

chat:
  title: Team PR Review Brief
  timezone: America/Los_Angeles
```

## Authentication

The tool resolves credentials in this order:

1. `PR_RADAR_GITHUB_TOKEN` env
2. `GITHUB_TOKEN` env
3. `GH_TOKEN` env
4. `gh auth token --hostname <host>` (local dev only)

For GitHub Enterprise, set `github.host` in config.

## GitHub Actions

`init` also generates `.github/workflows/pr-radar.yml`:

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

## States Detected

| State | Meaning |
|---|---|
| 🟢 Ready for Review | Review requested, waiting |
| 🟠 Needs Reviewer | No reviewer assigned |
| 🟡 Re-Review Needed | Author pushed after review |
| 🔴 Author Action Needed | Changes requested |
| ✅ Approved | Approved, waiting merge |

Also flags: CI failure, unresolved threads, stale/urgent thresholds, draft PRs (ignored by default).

## Development

```bash
npm install
npm run typecheck
npm run build
npm run test:message   # dry run
npm run test:chat      # test webhook only
```