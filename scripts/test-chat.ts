import { sendGoogleChatMessage } from "./google-chat.js";

async function main(): Promise<void> {
  const timestamp = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date());

  const message = [
    "🚦 PR Radar test message",
    "",
    `Sent at: ${timestamp}`,
    "",
    "If you can see this in Google Chat, the webhook is configured correctly.",
  ].join("\n");

  await sendGoogleChatMessage(message);
  console.log("Google Chat test message sent successfully.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
