import { loadConfig } from "./config.js";
import { fetchFollowUpPRs, fetchOpenPRs } from "./github.js";
import { classifyPRs } from "./classifier.js";
import { addAiNotes } from "./ai.js";
import { formatBrief, formatFollowUpBrief } from "./formatter.js";
import { sendGoogleChatMessage } from "./google-chat.js";
import type { RadarConfig } from "./types.js";

export async function main(configPath?: string): Promise<void> {
  let config = await loadConfig(configPath);

  // Resolve $ME placeholder in filters + teams
  const { me } = await resolveCurrentUserWithTeams(config.github.host);
  config = expandMe(config, me);

  if (process.env.PR_RADAR_FOLLOW_UP === "true") {
    if (!me) {
      throw new Error("--follow-up requires GitHub authentication via gh auth.");
    }
    console.log(`🔁 --follow-up: showing PRs reviewed/commented by ${me} that may need attention`);
    config.chat.title = "My Review Follow-up Brief";
    const followUps = await fetchFollowUpPRs(config, me);
    console.log(`Found ${followUps.length} follow-up PR(s).`);
    const message = formatFollowUpBrief(followUps, config);
    await sendGoogleChatMessage(message);
    console.log("PR brief sent successfully.");
    return;
  }

  // --mine flag: show all open PRs authored by me in the configured repos.
  if (process.env.PR_RADAR_MINE === "true" && me) {
    console.log(`🔍 --mine: showing open PRs authored by ${me}`);
    config.runtime = { ...(config.runtime || {}), author: me, authoredOnly: true };
    config.chat.title = `My Open PR Brief`;
  }

  console.log("Fetching open PRs...");
  const prs = await fetchOpenPRs(config);
  console.log(`Fetched ${prs.length} open PR(s).`);

  const classified = classifyPRs(prs, config);
  console.log(`Classified ${classified.length} active PR(s).`);

  const enriched = await addAiNotes(classified, config);
  const message = formatBrief(enriched, config);

  await sendGoogleChatMessage(message);
  console.log("PR brief sent successfully.");
}

async function resolveCurrentUserWithTeams(host: string): Promise<{ me: string; myTeams: string[] }> {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    const hostArgs = host === "github.com" ? [] : ["--hostname", host];
    const { stdout: user } = await exec("gh", ["api", ...hostArgs, "user", "--jq", ".login"], { timeout: 5000 });
    const me = user.trim();

    // Resolve team memberships on the same GitHub/GHE host as the configured repos.
    const { stdout: teamsJson } = await exec("gh", ["api", ...hostArgs, "user/teams", "--jq", ".[].slug"], { timeout: 5000 });
    const myTeams = teamsJson.trim().split("\n").filter(Boolean);

    return { me, myTeams };
  } catch {
    return { me: "", myTeams: [] };
  }
}

/** Replace $ME placeholder in filters with actual username */
function expandMe(config: RadarConfig, me: string): RadarConfig {
  if (!me) return config;
  const expand = (arr: string[]) => arr.map((v) => (v === "$ME" ? me : v));
  return {
    ...config,
    filters: {
      ...config.filters,
      reviewers: {
        include: expand(config.filters.reviewers.include),
        exclude: expand(config.filters.reviewers.exclude),
      },
    },
  };
}

// Allows running as a standalone script (npm run brief)
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}