import type { ClassifiedPR, RadarConfig } from "./types.js";

interface OpenAIChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

export async function addAiNotes(classified: ClassifiedPR[], config: RadarConfig): Promise<ClassifiedPR[]> {
  if (!config.ai.enabled || !process.env.OPENAI_API_KEY) {
    return classified;
  }

  const limit = Math.min(config.rules.max_prs_to_ai_summarize, classified.length);
  const targets = classified.slice(0, limit);

  const enriched = [...classified];
  for (let i = 0; i < targets.length; i += 1) {
    try {
      enriched[i] = {
        ...enriched[i],
        aiNote: await summarizePR(targets[i], config),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`AI summary failed for ${targets[i].repo}#${targets[i].number}:`, message);
    }
  }

  return enriched;
}

async function summarizePR(pr: ClassifiedPR, config: RadarConfig): Promise<string> {
  const prompt = `You are an engineering team PR review coordinator.
Write one concise sentence for a Google Chat PR review brief.
Focus on what changed, risk area, and what reviewer/author should pay attention to.
Do not repeat URL or generic status. Keep it under 30 words.

PR metadata:
- repo: ${pr.repo}
- number: ${pr.number}
- title: ${pr.title}
- author: ${pr.author}
- status: ${pr.status}
- reason: ${pr.reason}
- labels: ${pr.labels.join(", ") || "none"}
- changed files: ${pr.changedFiles.slice(0, 20).join(", ") || "unknown"}
- last commit: ${pr.lastCommitMessage || "unknown"}
- description: ${truncate(pr.bodyText || "", 1200)}
`;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.ai.model,
      messages: [
        { role: "system", content: "You write terse, practical engineering coordination notes." },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 80,
    }),
  });

  const payload = (await response.json()) as OpenAIChatCompletionResponse | Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`OpenAI API failed: ${JSON.stringify(payload)}`);
  }

  return (payload as OpenAIChatCompletionResponse).choices?.[0]?.message?.content?.trim() || "";
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
