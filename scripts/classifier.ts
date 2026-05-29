import { hoursBetween } from "./time.js";
import type { ClassifiedPR, LatestReview, NormalizedPR, PullRequestStatus, RadarConfig } from "./types.js";

export function classifyPRs(prs: NormalizedPR[], config: RadarConfig): ClassifiedPR[] {
  const now = new Date();
  return prs
    .filter((pr) => !(config.rules.ignore_draft && pr.isDraft))
    .filter((pr) => matchesFilters(pr, config))
    .map((pr) => classifyPR(pr, config, now))
    .sort((a, b) => b.priorityScore - a.priorityScore);
}

function matchesFilters(pr: NormalizedPR, config: RadarConfig): boolean {
  if (config.runtime?.author && pr.author.toLowerCase() !== config.runtime.author.toLowerCase()) {
    return false;
  }

  if (config.runtime?.authoredOnly) {
    return true;
  }

  const includeReviewers = config.filters.reviewers.include.map(normalizeReviewerFilterValue);
  const excludeReviewers = config.filters.reviewers.exclude.map(normalizeReviewerFilterValue);
  const prReviewers = new Set(pr.requestedReviewers.map((x) => x.toLowerCase()));

  if (includeReviewers.length > 0 && !includeReviewers.some((r) => prReviewers.has(r))) {
    return false;
  }

  if (excludeReviewers.length > 0 && excludeReviewers.some((r) => prReviewers.has(r))) {
    return false;
  }

  return true;
}

function normalizeReviewerFilterValue(value: string): string {
  const raw = value.trim();
  const lower = raw.toLowerCase();
  if (lower.startsWith("user:")) return lower.slice("user:".length);
  if (lower.startsWith("team:")) return lower.slice("team:".length).split("/").at(-1) || lower;
  if (lower.startsWith("@")) return lower.slice(1);
  return lower.split("/").at(-1) || lower;
}

function classifyPR(pr: NormalizedPR, config: RadarConfig, now: Date): ClassifiedPR {
  const latestReviews = pr.latestReviews || [];
  const changesRequestedReviews = latestReviews.filter((r) => r.state === "CHANGES_REQUESTED");
  const approvals = latestReviews.filter((r) => r.state === "APPROVED");
  const latestChangesRequestedAt = maxDate(changesRequestedReviews.map((r) => r.submittedAt));
  const lastCommitAt = pr.lastCommitAt ? new Date(pr.lastCommitAt) : null;
  const authorPushedAfterChanges = Boolean(latestChangesRequestedAt && lastCommitAt && lastCommitAt > latestChangesRequestedAt);
  const hasRequestedReviewers = pr.requestedReviewers.length > 0;
  const hasUnresolvedThreads = pr.unresolvedThreadCount > 0;
  const ciFailed = ["FAILURE", "ERROR", "EXPECTED"].includes(pr.ciState);
  const ciPassing = pr.ciState === "SUCCESS";

  let status: PullRequestStatus = "ready_for_review";
  let currentOwner = "reviewer";
  let waitingFor = pr.requestedReviewers;
  let waitingSince = pr.createdAt;
  let reason = "PR is open and ready for review.";

  if (changesRequestedReviews.length > 0 && !authorPushedAfterChanges) {
    status = "author_action_needed";
    currentOwner = "author";
    waitingFor = [pr.author];
    waitingSince = latestChangesRequestedAt?.toISOString() || pr.updatedAt;
    reason = `Changes requested by ${reviewAuthors(changesRequestedReviews) || "reviewer"}.`;
  } else if (changesRequestedReviews.length > 0 && authorPushedAfterChanges) {
    status = "re_review_needed";
    currentOwner = "reviewer";
    waitingFor = changesRequestedReviews.map((r) => r.author?.login).filter((x): x is string => Boolean(x));
    waitingSince = pr.lastCommitAt || pr.updatedAt;
    reason = "Author pushed new commits after changes were requested.";
  } else if (!hasRequestedReviewers && approvals.length === 0) {
    status = "needs_reviewer";
    currentOwner = "team";
    waitingFor = [];
    waitingSince = pr.createdAt;
    reason = "No reviewer is assigned.";
  } else if (approvals.length > 0 && !ciFailed && config.rules.include_approved_waiting_merge) {
    status = "approved_waiting_merge";
    currentOwner = "author/maintainer";
    waitingFor = [pr.author];
    waitingSince = maxDate(approvals.map((r) => r.submittedAt))?.toISOString() || pr.updatedAt;
    reason = ciPassing ? "Approved and CI is passing." : "Approved; check merge readiness.";
  } else if (hasRequestedReviewers) {
    status = "ready_for_review";
    currentOwner = "reviewer";
    waitingFor = pr.requestedReviewers;
    waitingSince = pr.createdAt;
    reason = "Review has been requested.";
  }

  if (ciFailed) {
    reason = `${reason} CI state: ${pr.ciState}.`;
  }
  if (hasUnresolvedThreads && status !== "author_action_needed") {
    reason = `${reason} ${pr.unresolvedThreadCount} unresolved review thread(s).`;
  }

  const waitingHours = hoursBetween(waitingSince, now);
  const stale = waitingHours >= config.rules.stale_after_hours;
  const urgent = waitingHours >= config.rules.urgent_after_hours;
  const priorityScore = scorePR({ pr, status, waitingHours, stale, urgent, ciFailed, hasUnresolvedThreads });

  return {
    ...pr,
    status,
    currentOwner,
    waitingFor,
    waitingSince,
    waitingHours,
    stale,
    urgent,
    ciFailed,
    hasUnresolvedThreads,
    reason,
    priorityScore,
    aiNote: "",
  };
}

function maxDate(values: Array<string | undefined | null>): Date | null {
  const dates = values.filter(Boolean).map((x) => new Date(x as string));
  if (dates.length === 0) return null;
  return new Date(Math.max(...dates.map((d) => d.getTime())));
}

function reviewAuthors(reviews: LatestReview[]): string {
  return reviews.map((r) => r.author?.login).filter(Boolean).join(", ");
}

function scorePR(input: {
  pr: NormalizedPR;
  status: PullRequestStatus;
  waitingHours: number;
  stale: boolean;
  urgent: boolean;
  ciFailed: boolean;
  hasUnresolvedThreads: boolean;
}): number {
  const { pr, status, waitingHours, stale, urgent, ciFailed, hasUnresolvedThreads } = input;
  const statusScore: Record<PullRequestStatus, number> = {
    re_review_needed: 85,
    needs_reviewer: 80,
    ready_for_review: 70,
    author_action_needed: 55,
    approved_waiting_merge: 45,
  };

  let score = statusScore[status] + Math.min(40, waitingHours * 1.5);
  if (stale) score += 20;
  if (urgent) score += 20;
  if (hasUnresolvedThreads) score += 10;
  if (ciFailed) score -= 15;
  if (pr.labels.some((l) => /urgent|blocker|release|hotfix|p0|p1/i.test(l))) score += 25;
  return Math.round(score);
}
