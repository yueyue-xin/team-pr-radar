import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import type { AIProvider, RadarConfig } from "./types.js";

type RawConfig = Partial<RadarConfig> & {
  github?: Partial<RadarConfig["github"]>;
  filters?: Partial<RadarConfig["filters"]> & {
    reviewers?: Partial<RadarConfig["filters"]["reviewers"]>;
  };
  rules?: Partial<RadarConfig["rules"]>;
  ai?: Partial<RadarConfig["ai"]>;
  chat?: Partial<RadarConfig["chat"]>;
};

export async function loadConfig(configPath?: string): Promise<RadarConfig> {
  const resolvedPath = configPath || path.resolve(process.cwd(), "config/pr-radar.yml");
  const raw = await fs.readFile(resolvedPath, "utf8");
  const config = yaml.load(raw) as RawConfig;

  if (!config?.github?.org) {
    throw new Error("config.github.org is required");
  }
  if (!Array.isArray(config.github.repos) || config.github.repos.length === 0) {
    throw new Error("config.github.repos must contain at least one repo");
  }

  const aiProvider = (config.ai?.provider as AIProvider) || "auto";
  if (!["auto", "openai", "anthropic", "custom", "command", "none"].includes(aiProvider)) {
    throw new Error(`config.ai.provider must be one of: auto, openai, anthropic, custom, command, none`);
  }

  // Resolve agent_file relative to config file directory
  const agentFile = config.ai?.agent_file || "";
  const resolvedAgentFile = agentFile
    ? path.resolve(path.dirname(resolvedPath), agentFile)
    : "";

  return {
    github: {
      host: config.github?.host || "github.com",
      org: config.github?.org || "",
      repos: config.github?.repos || [],
    },
    filters: {
      reviewers: {
        include: [],
        exclude: [],
        ...(config.filters?.reviewers || {}),
      },
    },
    rules: {
      ignore_draft: true,
      stale_after_hours: 24,
      urgent_after_hours: 48,
      max_open_prs_per_repo: 50,
      max_prs_in_brief: 8,
      max_prs_to_ai_summarize: 5,
      include_approved_waiting_merge: true,
      ...(config.rules || {}),
    },
    ai: {
      enabled: true,
      provider: aiProvider,
      model: config.ai?.model || "",
      base_url: config.ai?.base_url || "",
      command: config.ai?.command || "",
      agent_file: resolvedAgentFile,
    },
    chat: {
      title: "Team PR Review Brief",
      timezone: "UTC",
      ...(config.chat || {}),
    },
  };
}
