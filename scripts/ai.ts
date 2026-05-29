import { readFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import type { AIInsight, AIProvider, ClassifiedPR, RadarConfig } from "./types.js";

interface AIResponse {
  content: string;
}

interface AIProviderImpl {
  name: string;
  chat(systemPrompt: string, userPrompt: string, model: string): Promise<AIResponse>;
}

export async function addAiNotes(classified: ClassifiedPR[], config: RadarConfig): Promise<ClassifiedPR[]> {
  const provider = resolveProvider(config);
  if (!provider) return classified;
  console.log(`🤖 AI enabled: using ${provider.name}`);

  // Load agent.md if configured
  let agentPrompt = "";
  if (config.ai.agent_file) {
    try {
      agentPrompt = await readFile(config.ai.agent_file, "utf8");
    } catch {
      console.warn(`⚠️  agent_file not found: ${config.ai.agent_file}`);
    }
  }

  const limit = Math.min(config.rules.max_prs_to_ai_summarize, classified.length);
  const targets = classified.slice(0, limit);

  const enriched = [...classified];
  if (targets.length === 0) {
    return enriched;
  }

  console.log(`🤖 Generating AI insights for ${targets.length} PR(s)...`);

  let succeeded = 0;
  let failed = 0;
  for (let i = 0; i < targets.length; i += 1) {
    const pr = targets[i];
    console.log(`🤖 AI ${i + 1}/${targets.length}: ${pr.repo} #${pr.number}`);
    try {
      const insight = await analyzePR(pr, config, provider, agentPrompt);
      enriched[i] = {
        ...enriched[i],
        aiInsight: insight,
        aiNote: insight.summary,
      };
      succeeded += 1;
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`⚠️  AI failed for ${pr.repo} #${pr.number}: ${message}`);
    }
  }

  console.log(`🤖 AI insights completed: ${targets.length} attempted, ${succeeded} succeeded, ${failed} failed.`);
  return enriched;
}

/** Detect which provider to use based on env and config. Returns null if AI is unavailable. */
function resolveProvider(config: RadarConfig): AIProviderImpl | null {
  if (!config.ai.enabled || config.ai.provider === "none") return null;

  // Explicit provider
  if (config.ai.provider === "openai" && process.env.OPENAI_API_KEY) {
    return makeOpenAIProvider(process.env.OPENAI_API_KEY, config.ai.base_url);
  }
  if (config.ai.provider === "anthropic" && process.env.ANTHROPIC_API_KEY) {
    return makeAnthropicProvider(process.env.ANTHROPIC_API_KEY);
  }
  if (config.ai.provider === "custom" && (process.env.AI_API_KEY || config.ai.base_url)) {
    return makeOpenAIProvider(process.env.AI_API_KEY || "", config.ai.base_url);
  }
  if (config.ai.provider === "command") {
    const cursorAgentCommand = detectCursorAgentCommand();
    const command = process.env.AI_COMMAND || config.ai.command || cursorAgentCommand;
    if (command) return makeCommandProvider(command, command === cursorAgentCommand ? "Cursor Agent" : `command provider: ${shortCommand(command)}`);
  }

  // Auto-detect
  if (config.ai.provider === "auto") {
    if (process.env.ANTHROPIC_API_KEY) {
      return makeAnthropicProvider(process.env.ANTHROPIC_API_KEY);
    }
    if (process.env.OPENAI_API_KEY) {
      return makeOpenAIProvider(process.env.OPENAI_API_KEY, "");
    }
    if (process.env.AI_API_KEY && config.ai.base_url) {
      return makeOpenAIProvider(process.env.AI_API_KEY, config.ai.base_url);
    }
    if (process.env.AI_COMMAND || config.ai.command) {
      const command = process.env.AI_COMMAND || config.ai.command;
      return makeCommandProvider(command, `command provider: ${shortCommand(command)}`);
    }
    const cursorAgentCommand = detectCursorAgentCommand();
    if (cursorAgentCommand) {
      return makeCommandProvider(cursorAgentCommand, "Cursor Agent");
    }
  }

  console.warn("⚠️  AI enabled but no API key, AI command, or logged-in Cursor Agent found. Skipping AI insights.");
  console.warn("   Set ANTHROPIC_API_KEY, OPENAI_API_KEY, AI_API_KEY, AI_COMMAND, or run `cursor agent login`.");
  return null;
}

function detectCursorAgentCommand(): string {
  const result = spawnSync("sh", ["-lc", "command -v cursor >/dev/null 2>&1 && cursor agent status >/dev/null 2>&1"], {
    encoding: "utf8",
    timeout: 15000,
    env: process.env,
  });
  if (result.status !== 0) return "";
  return "cursor agent -p --mode ask --model auto --trust --output-format text";
}

function makeCommandProvider(command: string, name = `command provider: ${shortCommand(command)}`): AIProviderImpl {
  return {
    name,
    async chat(systemPrompt, userPrompt) {
      const prompt = `${systemPrompt}\n\n${userPrompt}`;
      const output = await runCommand(command, prompt);
      return { content: output.trim().replace(/\s+/g, " ") };
    },
  };
}

async function runCommand(command: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-lc", command], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`AI command timed out: ${command}`));
    }, Number(process.env.AI_COMMAND_TIMEOUT_MS || 60_000));

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr.trim() || `AI command exited with code ${code}`));
      }
    });
    child.stdin.end(input);
  });
}

function shortCommand(command: string): string {
  const sanitized = command
    .replace(/(--api-key\s+)\S+/g, "$1<redacted>")
    .replace(/(CURSOR_API_KEY=)\S+/g, "$1<redacted>")
    .replace(/(OPENAI_API_KEY=)\S+/g, "$1<redacted>")
    .replace(/(ANTHROPIC_API_KEY=)\S+/g, "$1<redacted>");
  return sanitized.length > 80 ? `${sanitized.slice(0, 77)}...` : sanitized;
}

function makeOpenAIProvider(apiKey: string, baseUrl: string): AIProviderImpl {
  const endpoint = baseUrl
    ? `${baseUrl.replace(/\/$/, "")}/chat/completions`
    : "https://api.openai.com/v1/chat/completions";

  return {
    name: baseUrl ? "custom OpenAI-compatible provider" : "OpenAI",
    async chat(systemPrompt, userPrompt, model) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: model || "gpt-4o-mini",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.2,
          max_tokens: 300,
        }),
      });

      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        error?: { message: string };
      };

      if (!response.ok || payload.error) {
        throw new Error(payload.error?.message || `HTTP ${response.status}`);
      }

      return { content: payload.choices?.[0]?.message?.content?.trim() || "" };
    },
  };
}

function makeAnthropicProvider(apiKey: string): AIProviderImpl {
  return {
    name: "Anthropic",
    async chat(systemPrompt, userPrompt, model) {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: model || "claude-3-5-haiku-latest",
          max_tokens: 300,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
        }),
      });

      const payload = (await response.json()) as {
        content?: Array<{ type: string; text: string }>;
        error?: { message: string };
      };

      if (!response.ok || payload.error) {
        throw new Error(payload.error?.message || `HTTP ${response.status}`);
      }

      const text = payload.content?.find((c) => c.type === "text")?.text?.trim() || "";
      return { content: text };
    },
  };
}

async function analyzePR(
  pr: ClassifiedPR,
  config: RadarConfig,
  provider: AIProviderImpl,
  agentPrompt: string,
): Promise<AIInsight> {
  const systemPrompt = agentPrompt
    ? `${agentPrompt}\n\nYou are a PR review coordination assistant. Return ONLY valid JSON, no Markdown.`
    : "You are a PR review coordination assistant. Return ONLY valid JSON, no Markdown.";

  const userPrompt = `Analyze this PR for a team review radar. Decide what should happen next.

Return exactly this JSON shape:
{
  "summary": "<= 20 words describing what the PR appears to change",
  "nextAction": "<= 24 words with the most useful next action",
  "owner": "author|reviewer|maintainer|ci|unknown",
  "risk": "low|medium|high|unknown",
  "confidence": 0.0,
  "evidence": ["short evidence item 1", "short evidence item 2"]
}

Rules:
- Use only the metadata below; do not invent file contents.
- If CI is failing/expected, mention CI only when it changes the next action or risk.
- If there are no requested reviewers, owner is usually author or maintainer and nextAction should mention requesting reviewers.
- If review is requested, owner is usually reviewer.
- If changes were requested and no newer commit is known, owner is usually author.
- Keep summary and nextAction terse for Google Chat.

PR metadata:
- repo: ${pr.repo}
- number: ${pr.number}
- title: ${pr.title}
- author: ${pr.author}
- status: ${pr.status}
- current owner by rules: ${pr.currentOwner}
- waiting for: ${pr.waitingFor.join(", ") || "none"}
- waiting hours: ${Math.round(pr.waitingHours)}
- stale: ${pr.stale}
- urgent: ${pr.urgent}
- ci state: ${pr.ciState}
- rule reason: ${pr.reason}
- labels: ${pr.labels.join(", ") || "none"}
- requested reviewers: ${pr.requestedReviewers.join(", ") || "none"}
- changed file count: ${pr.changedFileCount}
- changed files: ${pr.changedFiles.slice(0, 20).join(", ") || "not fetched"}
- last commit: ${pr.lastCommitMessage || "not fetched"}
- description: ${truncate(pr.bodyText || "", 1200)}`;

  const result = await provider.chat(systemPrompt, userPrompt, config.ai.model);
  return parseAIInsight(result.content, pr);
}

function parseAIInsight(content: string, pr: ClassifiedPR): AIInsight {
  const json = extractJsonObject(content);
  if (!json) {
    return fallbackInsight(pr, content);
  }

  try {
    const parsed = JSON.parse(json) as Partial<AIInsight>;
    return normalizeInsight(parsed, pr, content);
  } catch {
    return fallbackInsight(pr, content);
  }
}

function extractJsonObject(content: string): string {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced) return fenced;
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start >= 0 && end > start) return content.slice(start, end + 1);
  return "";
}

function normalizeInsight(parsed: Partial<AIInsight>, pr: ClassifiedPR, raw: string): AIInsight {
  const owner = ["author", "reviewer", "maintainer", "ci", "unknown"].includes(parsed.owner || "")
    ? parsed.owner as AIInsight["owner"]
    : defaultOwner(pr);
  const risk = ["low", "medium", "high", "unknown"].includes(parsed.risk || "")
    ? parsed.risk as AIInsight["risk"]
    : defaultRisk(pr);

  return {
    summary: truncateOneLine(parsed.summary || raw || pr.title, 180),
    nextAction: truncateOneLine(parsed.nextAction || pr.reason, 200),
    owner,
    risk,
    confidence: clampConfidence(parsed.confidence),
    evidence: Array.isArray(parsed.evidence)
      ? parsed.evidence.map((x) => truncateOneLine(String(x), 120)).slice(0, 3)
      : [],
  };
}

function fallbackInsight(pr: ClassifiedPR, raw: string): AIInsight {
  return {
    summary: truncateOneLine(raw || pr.title, 180),
    nextAction: pr.reason,
    owner: defaultOwner(pr),
    risk: defaultRisk(pr),
    confidence: 0.3,
    evidence: [pr.reason],
  };
}

function defaultOwner(pr: ClassifiedPR): AIInsight["owner"] {
  if (pr.ciFailed) return "ci";
  if (pr.currentOwner === "author") return "author";
  if (pr.currentOwner === "reviewer") return "reviewer";
  if (pr.currentOwner.includes("maintainer")) return "maintainer";
  return "unknown";
}

function defaultRisk(pr: ClassifiedPR): AIInsight["risk"] {
  if (pr.ciFailed || pr.changedFileCount > 50) return "high";
  if (pr.urgent || pr.changedFileCount > 15) return "medium";
  return "low";
}

function clampConfidence(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

function truncateOneLine(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 3)}...` : oneLine;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}