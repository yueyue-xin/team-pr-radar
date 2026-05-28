export async function sendGoogleChatMessage(text: string): Promise<void> {
  const webhookUrl = process.env.GOOGLE_CHAT_WEBHOOK_URL;
  const dryRun = process.env.PR_RADAR_DRY_RUN === "true";

  if (dryRun) {
    console.log("\n--- Google Chat dry run message ---\n");
    console.log(text);
    console.log("\n--- End dry run message ---\n");
    return;
  }

  if (!webhookUrl) {
    throw new Error("GOOGLE_CHAT_WEBHOOK_URL is missing");
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to send Google Chat message: ${response.status} ${body}`);
  }
}
