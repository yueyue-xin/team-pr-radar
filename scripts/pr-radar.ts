import { loadConfig } from "./config.js";
import { fetchOpenPRs } from "./github.js";
import { classifyPRs } from "./classifier.js";
import { addAiNotes } from "./ai.js";
import { formatBrief } from "./formatter.js";
import { sendGoogleChatMessage } from "./google-chat.js";

export async function main(configPath?: string): Promise<void> {
  const config = await loadConfig(configPath);

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

// Allows running as a standalone script (npm run brief)
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
