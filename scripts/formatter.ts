import { formatDuration, nowInTimezone } from "./time.js";
import type { ClassifiedPR, FollowUpPR, PullRequestStatus, RadarConfig } from "./types.js";

const STATUS_BADGE: Record<PullRequestStatus, string> = {
  ready_for_review: "🟢 Ready for Review",
  needs_reviewer: "🟠 Needs Reviewer",
  re_review_needed: "🟡 Re-Review Needed",
  author_action_needed: "🔴 Author Action Needed",
  approved_waiting_merge: "✅ Approved",
};

const STATUS_LABEL: Record<PullRequestStatus, string> = {
  ready_for_review: "Ready for Review",
  needs_reviewer: "Needs Reviewer",
  re_review_needed: "Re-Review Needed",
  author_action_needed: "Author Action Needed",
  approved_waiting_merge: "Approved",
};

export function formatBrief(classified: ClassifiedPR[], config: RadarConfig): string {
  const maxItems = config.rules.max_prs_in_brief;
  const top = classified.slice(0, maxItems);
  const counts = countBy(classified, "status");
  const staleCount = classified.filter((pr) => pr.stale).length;
  const title = config.chat.title;
  const timestamp = nowInTimezone(config.chat.timezone);

  const lines: string[] = [];

  // ── Header ──
  lines.push(`🚦 *${title}* (${timestamp})`);
  lines.push("");

  // ── Empty state ──
  if (classified.length === 0) {
    lines.push("🎉 No active PRs need attention right now.");
    return lines.join("\n");
  }

  // ── Summary ──
  const summaryParts: string[] = [];
  summaryParts.push(`*${classified.length}* active`);
  if (counts.ready_for_review) summaryParts.push(`🟢 ${counts.ready_for_review}`);
  if (counts.needs_reviewer) summaryParts.push(`🟠 ${counts.needs_reviewer}`);
  if (counts.re_review_needed) summaryParts.push(`🟡 ${counts.re_review_needed}`);
  if (counts.author_action_needed) summaryParts.push(`🔴 ${counts.author_action_needed}`);
  if (counts.approved_waiting_merge) summaryParts.push(`✅ ${counts.approved_waiting_merge}`);
  if (staleCount) summaryParts.push(`⏰ ${staleCount} stale`);
  lines.push(`> ${summaryParts.join(" · ")}`);
  lines.push("");

  // ── PR cards ──
  top.forEach((pr, index) => {
    // Status badge + PR ID
    lines.push(`*[${STATUS_BADGE[pr.status]}]* *${pr.repo} #${pr.number}*`);

    // Title
    lines.push(`*Title*   ${pr.title}`);

    // Author + time metrics
    const waiting = formatDuration(pr.waitingHours);
    const reviewTime = estimateReviewTime(pr.changedFileCount);
    lines.push(`*Author*  ${pr.author} (⏳ ${waiting} ago | ⏱ ~${reviewTime} read)`);

    // Health: CI + unresolved + stale/urgent
    const healthParts: string[] = [];
    if (pr.ciFailed) healthParts.push(`⚠️ CI ${pr.ciState}`);
    if (pr.hasUnresolvedThreads) {
      const label = pr.unresolvedThreadCount === 1 ? "1 unresolved comment" : `${pr.unresolvedThreadCount} unresolved comments`;
      healthParts.push(`💬 ${label}`);
    }
    if (pr.urgent) healthParts.push("🚨 urgent");
    else if (pr.stale) healthParts.push("⏰ stale");
    if (healthParts.length > 0) {
      lines.push(`*Health*  ${healthParts.join(" · ")}`);
    }

    // Reviewers
    if (pr.waitingFor.length > 0) {
      lines.push(`*Reviewers*  ${pr.waitingFor.join(", ")}`);
    }

    // Labels
    if (pr.labels.length > 0) {
      lines.push(`*Labels*  ${pr.labels.join(", ")}`);
    }

    // AI insight
    if (pr.aiInsight) {
      const risk = formatRisk(pr.aiInsight.risk);
      const owner = formatOwner(pr.aiInsight.owner);
      lines.push(`*AI*  🤖 ${risk} · Owner: ${owner} · Confidence: ${Math.round(pr.aiInsight.confidence * 100)}%`);
      if (pr.aiInsight.summary) lines.push(`*Summary*  ${pr.aiInsight.summary}`);
      if (pr.aiInsight.nextAction) lines.push(`*Next*  ${pr.aiInsight.nextAction}`);
    } else if (pr.aiNote) {
      lines.push(`*Note*  🤖 ${pr.aiNote}`);
    }

    // Link
    lines.push(`🔗 ${pr.url}`);

    // Separator between PRs
    if (index < top.length - 1) {
      lines.push("");
      lines.push("---");
      lines.push("");
    }
  });

  if (classified.length > top.length) {
    lines.push("");
    lines.push(`> *+${classified.length - top.length} more PR(s)*`);
  }

  return lines.join("\n");
}

export function formatFollowUpBrief(prs: FollowUpPR[], config: RadarConfig): string {
  const maxItems = config.rules.max_prs_in_brief;
  const top = prs.slice(0, maxItems);
  const timestamp = nowInTimezone(config.chat.timezone);
  const lines: string[] = [];

  lines.push(`🔁 *${config.chat.title}* (${timestamp})`);
  lines.push("");

  if (prs.length === 0) {
    lines.push("🎉 No review follow-ups need attention right now.");
    return lines.join("\n");
  }

  const newCommitCount = prs.filter((pr) => pr.hasNewCommitsAfterMyActivity).length;
  lines.push(`> *${prs.length}* follow-up PR(s) · 🔁 ${newCommitCount} with new commits after your activity`);
  lines.push("");

  top.forEach((pr, index) => {
    lines.push(`*[🔁 Follow-up]* *${pr.repo} #${pr.number}*`);
    lines.push(`*Title*   ${pr.title}`);
    lines.push(`*Author*  ${pr.author}`);
    lines.push(`*Reason*  ${pr.followUpReasons.join(" · ")}`);
    if (pr.myLastReviewAt) {
      lines.push(`*Your last review*  ${pr.myLastReviewState || "UNKNOWN"} at ${pr.myLastReviewAt}`);
    }
    if (pr.myLastCommentAt) {
      lines.push(`*Your last comment*  ${pr.myLastCommentAt}`);
    }
    if (pr.lastCommitAt) {
      lines.push(`*Latest commit*  ${pr.lastCommitAt}${pr.lastCommitMessage ? ` — ${pr.lastCommitMessage}` : ""}`);
    }
    if (pr.labels.length > 0) {
      lines.push(`*Labels*  ${pr.labels.join(", ")}`);
    }
    lines.push(`🔗 ${pr.url}`);

    if (index < top.length - 1) {
      lines.push("");
      lines.push("---");
      lines.push("");
    }
  });

  if (prs.length > top.length) {
    lines.push("");
    lines.push(`> *+${prs.length - top.length} more PR(s)*`);
  }

  return lines.join("\n");
}

function formatRisk(risk: string): string {
  if (risk === "high") return "🔴 High risk";
  if (risk === "medium") return "🟡 Medium risk";
  if (risk === "low") return "🟢 Low risk";
  return "⚪ Unknown risk";
}

function formatOwner(owner: string): string {
  if (owner === "author") return "author";
  if (owner === "reviewer") return "reviewer";
  if (owner === "maintainer") return "maintainer";
  if (owner === "ci") return "CI";
  return "unknown";
}

function estimateReviewTime(fileCount: number): string {
  if (fileCount <= 5) return "3m";
  if (fileCount <= 15) return "6m";
  if (fileCount <= 30) return "12m";
  if (fileCount <= 50) return "18m";
  return "25m+";
}

function countBy<T extends Record<K, string>, K extends keyof T>(items: T[], key: K): Record<string, number> {
  return items.reduce<Record<string, number>>((acc, item) => {
    acc[item[key]] = (acc[item[key]] || 0) + 1;
    return acc;
  }, {});
}
