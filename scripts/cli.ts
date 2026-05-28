#!/usr/bin/env node
import { writeFile, mkdir, access } from "node:fs/promises";
import { resolve } from "node:path";
import { main } from "./pr-radar.js";

const args = process.argv.slice(2);

// ── init ────────────────────────────────────────
if (args[0] === "init") {
  const dest = args[1] || process.cwd();

  // Config template
  const yml = `# PR Radar configuration — see https://github.com/user/team-pr-radar#readme
github:
  host: github.com          # or your GitHub Enterprise host (e.g. github-vcf.devops.broadcom.net)
  org: your-org
  repos:
    - your-repo

filters:
  labels:
    include: []
    exclude: []
  reviewers:
    include: []             # team names or individual usernames
    exclude: []
  paths:
    include: []             # glob-like prefixes, e.g. packages/ui/**
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
  enabled: false            # set OPENAI_API_KEY to enable AI notes
  model: gpt-4o-mini

chat:
  title: Team PR Review Brief
  timezone: UTC             # e.g. America/Los_Angeles, Asia/Shanghai
`;

  // GitHub Actions workflow
  const workflow = `name: PR Radar

on:
  schedule:
    - cron: '0 10 * * 1-5'  # every weekday at 10:00 UTC, adjust to your timezone
  workflow_dispatch:          # allow manual trigger

jobs:
  pr-radar:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Send PR brief
        run: npx team-pr-radar
        env:
          GOOGLE_CHAT_WEBHOOK_URL: \${{ secrets.GOOGLE_CHAT_WEBHOOK_URL }}
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
`;

  const configDir = resolve(dest, "config");
  const workflowsDir = resolve(dest, ".github/workflows");
  await mkdir(configDir, { recursive: true });
  await mkdir(workflowsDir, { recursive: true });
  await writeFile(resolve(configDir, "pr-radar.yml"), yml, "utf8");
  await writeFile(resolve(workflowsDir, "pr-radar.yml"), workflow, "utf8");

  console.log("✅ Generated:");
  console.log("   config/pr-radar.yml");
  console.log("   .github/workflows/pr-radar.yml");
  console.log("");
  console.log("Next steps:");
  console.log("1. Edit config/pr-radar.yml with your GitHub and team settings");
  console.log('2. Set GOOGLE_CHAT_WEBHOOK_URL secret in your GitHub repo (Settings → Secrets and variables → Actions)');
  console.log("3. Run: npx team-pr-radar");
  process.exit(0);
}

// ── run (default) ───────────────────────────────
const configArg = args.find((a) => a.startsWith("--config="));
const configPath = configArg ? configArg.split("=")[1] : undefined;

// If no --config, check if the default config file exists
if (!configPath) {
  try {
    await access(resolve(process.cwd(), "config/pr-radar.yml"));
  } catch {
    console.error("❌ No config found at config/pr-radar.yml");
    console.error("   Run: npx team-pr-radar init");
    process.exit(1);
  }
}

main(configPath).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});