#!/usr/bin/env node
import { writeFile, mkdir, access } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { main } from "./pr-radar.js";

const execFile = promisify(execFileCallback);

const args = process.argv.slice(2);

// Resolve $ME from gh auth
let currentUser = "";
async function resolveMe(): Promise<string> {
  if (currentUser) return currentUser;
  try {
    const { stdout } = await execFile("gh", ["api", "user", "--jq", ".login"], { timeout: 5000 });
    currentUser = stdout.trim();
  } catch {
    // gh not available
  }
  return currentUser;
}

// ── init ────────────────────────────────────────
if (args[0] === "init") {
  const dest = args[1] || process.cwd();

  const yml = `# PR Radar configuration — see https://github.com/yueyue-xin/team-pr-radar#readme
github:
  host: github.com          # or your GitHub Enterprise host
  org: your-org
  repos:
    - your-repo

filters:
  reviewers:
    include: []             # team names by default; use user:<login> or team:<slug> when needed
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
  provider: auto            # auto | openai | anthropic | custom | command | none
  model: ""                 # blank = auto-select default
  base_url: ""              # custom endpoint for provider: custom
  command: ""               # provider: command, reads prompt from stdin and writes summary to stdout
  agent_file: ""            # optional, e.g. agent.md

chat:
  title: Team PR Review Brief
  timezone: UTC             # e.g. America/Los_Angeles, Asia/Shanghai
`;

  const workflow = `name: PR Radar

on:
  schedule:
    - cron: '0 10 * * 1-5'  # every weekday at 10:00 UTC
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
  console.log('2. Set GOOGLE_CHAT_WEBHOOK_URL secret in your GitHub repo');
  console.log("3. Run: npx team-pr-radar");
  console.log("");
  console.log("💡  For AI summaries: export OPENAI_API_KEY or ANTHROPIC_API_KEY");
  process.exit(0);
}

// ── resolve runtime flags ───────────────────────
const isMine = args.includes("--mine");
const isFollowUp = args.includes("--follow-up");
if (isMine && isFollowUp) {
  console.error("❌ --mine and --follow-up are separate modes and cannot be used together.");
  process.exit(1);
}
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

// Pass mode flags as env so pr-radar can pick them up
if (isMine) {
  process.env.PR_RADAR_MINE = "true";
}
if (isFollowUp) {
  process.env.PR_RADAR_FOLLOW_UP = "true";
}

main(configPath).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
