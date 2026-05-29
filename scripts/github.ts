import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import type { FollowUpPR, LatestReview, NormalizedPR, RadarConfig } from "./types.js";

const execFile = promisify(execFileCallback);

const GH_PR_LIST_FIELDS = [
  "number",
  "title",
  "url",
  "body",
  "author",
  "createdAt",
  "updatedAt",
  "isDraft",
  "mergeable",
  "labels",
  "reviewRequests",
  "latestReviews",
  "changedFiles",
  "statusCheckRollup",
].join(",");

interface GhUser {
  login?: string;
}

interface GhLabel {
  name: string;
}

interface GhReviewRequest {
  __typename?: "User" | "Team" | string;
  login?: string;
  name?: string;
  slug?: string;
}

interface GhStatusCheck {
  status?: string;
  conclusion?: string;
  state?: string;
}

interface GhCommit {
  authoredDate?: string;
  committedDate?: string;
  messageHeadline?: string;
}

interface GhComment {
  author?: GhUser | null;
  createdAt: string;
}

interface GhPullRequest {
  number: number;
  title: string;
  url: string;
  body?: string;
  author?: GhUser | null;
  createdAt: string;
  updatedAt: string;
  isDraft: boolean;
  mergeable?: string;
  labels?: GhLabel[];
  reviewRequests?: GhReviewRequest[];
  latestReviews?: LatestReview[];
  reviews?: LatestReview[];
  comments?: GhComment[];
  commits?: GhCommit[];
  changedFiles?: number;
  statusCheckRollup?: GhStatusCheck[];
}

export async function fetchOpenPRs(config: RadarConfig): Promise<NormalizedPR[]> {
  const { org, repos, host } = config.github;
  const all: NormalizedPR[] = [];

  for (const repo of repos) {
    const prs = await fetchRepoOpenPRsViaGh(config, org, repo, host);
    all.push(...prs);
  }

  return all;
}

async function fetchRepoOpenPRsViaGh(
  config: RadarConfig,
  owner: string,
  repo: string,
  host: string,
): Promise<NormalizedPR[]> {
  if (config.runtime?.authoredOnly) {
    const payload = await runGhPrList(config, owner, repo, host, "");
    return payload.map((pr) => normalizeGhPR(owner, repo, pr));
  }

  const includeSearches = buildReviewRequestIncludeSearches(owner, config);
  const excludeSearch = buildReviewRequestExcludeSearch(owner, config);

  if (includeSearches.length === 0) {
    const payload = await runGhPrList(config, owner, repo, host, excludeSearch);
    return payload.map((pr) => normalizeGhPR(owner, repo, pr));
  }

  // Multiple include reviewers are OR semantics for the radar. Run one native GitHub
  // search per include qualifier and union the results by PR number.
  const byNumber = new Map<number, GhPullRequest>();
  for (const includeSearch of includeSearches) {
    const search = [includeSearch, excludeSearch].filter(Boolean).join(" ");
    const payload = await runGhPrList(config, owner, repo, host, search);
    for (const pr of payload) {
      byNumber.set(pr.number, pr);
    }
  }

  return [...byNumber.values()].map((pr) => normalizeGhPR(owner, repo, pr));
}

async function runGhPrList(
  config: RadarConfig,
  owner: string,
  repo: string,
  host: string,
  search: string,
): Promise<GhPullRequest[]> {
  const args = [
    "pr",
    "list",
    "-R", `${host}/${owner}/${repo}`,
    "--state", "open",
    "--limit", String(config.rules.max_open_prs_per_repo),
    "--json", GH_PR_LIST_FIELDS,
  ];

  const effectiveSearch = [search, buildRuntimeSearch(config)].filter(Boolean).join(" ");
  if (effectiveSearch) {
    args.push("--search", effectiveSearch);
  }

  console.log(`🔎 gh ${args.join(" ")}`);

  const { stdout } = await execFile("gh", args, {
    timeout: 30000,
    maxBuffer: 20 * 1024 * 1024,
  });

  return JSON.parse(stdout) as GhPullRequest[];
}

function buildReviewRequestIncludeSearches(owner: string, config: RadarConfig): string[] {
  return config.filters.reviewers.include
    .map((reviewer) => toReviewRequestedQualifier(owner, reviewer))
    .filter(Boolean);
}

function buildReviewRequestExcludeSearch(owner: string, config: RadarConfig): string {
  return config.filters.reviewers.exclude
    .map((reviewer) => toReviewRequestedQualifier(owner, reviewer))
    .filter(Boolean)
    .map((qualifier) => `-${qualifier}`)
    .join(" ");
}

function buildRuntimeSearch(config: RadarConfig): string {
  return config.runtime?.author ? `author:${config.runtime.author}` : "";
}

export async function fetchFollowUpPRs(config: RadarConfig, username: string): Promise<FollowUpPR[]> {
  const { org, repos, host } = config.github;
  const all: FollowUpPR[] = [];

  for (const repo of repos) {
    const numbers = await findFollowUpCandidateNumbers(config, org, repo, host, username);
    for (const number of numbers) {
      const pr = await fetchPRDetails(org, repo, host, number);
      const followUp = analyzeFollowUpPR(normalizeGhPR(org, repo, pr), pr, username);
      if (followUp.followUpReasons.length > 0) {
        all.push(followUp);
      }
    }
  }

  return all.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

async function findFollowUpCandidateNumbers(
  config: RadarConfig,
  owner: string,
  repo: string,
  host: string,
  username: string,
): Promise<number[]> {
  const searches = [`reviewed-by:${username}`, `commenter:${username}`];
  const numbers = new Set<number>();

  for (const search of searches) {
    const args = [
      "pr",
      "list",
      "-R", `${host}/${owner}/${repo}`,
      "--state", "open",
      "--limit", String(config.rules.max_open_prs_per_repo),
      "--search", search,
      "--json", "number",
    ];
    console.log(`🔎 gh ${args.join(" ")}`);
    const { stdout } = await execFile("gh", args, { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    const payload = JSON.parse(stdout) as Array<{ number: number }>;
    for (const pr of payload) numbers.add(pr.number);
  }

  return [...numbers];
}

async function fetchPRDetails(owner: string, repo: string, host: string, number: number): Promise<GhPullRequest> {
  const fields = [
    GH_PR_LIST_FIELDS,
    "reviews",
    "comments",
    "commits",
  ].join(",");
  const args = [
    "pr",
    "view",
    String(number),
    "-R", `${host}/${owner}/${repo}`,
    "--json", fields,
  ];
  console.log(`🔎 gh ${args.join(" ")}`);
  const { stdout } = await execFile("gh", args, { timeout: 30000, maxBuffer: 20 * 1024 * 1024 });
  return JSON.parse(stdout) as GhPullRequest;
}

function analyzeFollowUpPR(pr: NormalizedPR, raw: GhPullRequest, username: string): FollowUpPR {
  const lowerUser = username.toLowerCase();
  if (pr.author.toLowerCase() === lowerUser) {
    return emptyFollowUpPR(pr);
  }

  const myReviews = (raw.reviews || raw.latestReviews || [])
    .filter((review) => review.author?.login?.toLowerCase() === lowerUser);
  const myComments = (raw.comments || [])
    .filter((comment) => comment.author?.login?.toLowerCase() === lowerUser);
  const myLastReview = latestByDate(myReviews, (review) => review.submittedAt);
  const myLastReviewAt = myLastReview?.submittedAt;
  const myLastCommentAt = maxIso(myComments.map((comment) => comment.createdAt));
  const myLastActivityAt = maxIso([myLastReviewAt, myLastCommentAt]);
  const lastCommit = (raw.commits || []).at(-1);
  const lastCommitAt = lastCommit?.committedDate || lastCommit?.authoredDate;
  const hasNewCommitsAfterMyActivity = Boolean(
    lastCommitAt && myLastActivityAt && new Date(lastCommitAt) > new Date(myLastActivityAt),
  );

  const followUpReasons: string[] = [];
  if (hasNewCommitsAfterMyActivity) {
    if (myLastReview?.state === "APPROVED") {
      followUpReasons.push("New commits were pushed after your approval.");
    } else if (myLastReview?.state === "CHANGES_REQUESTED") {
      followUpReasons.push("Author pushed new commits after your changes-requested review.");
    } else {
      followUpReasons.push("New commits were pushed after your last review/comment.");
    }
  } else if (myLastReview?.state === "CHANGES_REQUESTED") {
    followUpReasons.push("Waiting on author after your changes-requested review.");
  }

  return {
    ...pr,
    lastCommitAt,
    lastCommitMessage: lastCommit?.messageHeadline || pr.lastCommitMessage,
    followUpReasons,
    myLastReviewAt,
    myLastReviewState: myLastReview?.state,
    myLastCommentAt,
    myLastActivityAt,
    hasNewCommitsAfterMyActivity,
  };
}

function emptyFollowUpPR(pr: NormalizedPR): FollowUpPR {
  return {
    ...pr,
    followUpReasons: [],
    hasNewCommitsAfterMyActivity: false,
  };
}

function latestByDate<T>(values: T[], getDate: (value: T) => string | undefined | null): T | undefined {
  return values.reduce<T | undefined>((latest, value) => {
    if (!latest) return value;
    const latestTime = new Date(getDate(latest) || 0).getTime();
    const valueTime = new Date(getDate(value) || 0).getTime();
    return valueTime > latestTime ? value : latest;
  }, undefined);
}

function maxIso(values: Array<string | undefined | null>): string | undefined {
  const dates = values.filter(Boolean).map((value) => new Date(value as string));
  if (dates.length === 0) return undefined;
  return new Date(Math.max(...dates.map((date) => date.getTime()))).toISOString();
}

function toReviewRequestedQualifier(owner: string, reviewer: string): string {
  const raw = reviewer.trim();
  if (!raw) return "";

  const lower = raw.toLowerCase();
  if (lower.startsWith("user:")) {
    return `review-requested:${raw.slice("user:".length)}`;
  }
  if (raw.startsWith("@")) {
    return `review-requested:${raw.slice(1)}`;
  }
  if (lower.startsWith("team:")) {
    return toTeamReviewRequestedQualifier(owner, raw.slice("team:".length));
  }

  // Backward-compatible default: bare reviewer names in config are team slugs/names.
  return toTeamReviewRequestedQualifier(owner, raw);
}

function toTeamReviewRequestedQualifier(owner: string, team: string): string {
  const value = team.trim();
  return value.includes("/")
    ? `team-review-requested:${value}`
    : `team-review-requested:${owner}/${value}`;
}

function normalizeGhPR(owner: string, repo: string, pr: GhPullRequest): NormalizedPR {
  const requestedReviewers = (pr.reviewRequests || [])
    .map((r) => r.login || r.name || r.slug)
    .filter((x): x is string => Boolean(x));
  const reviewAuthors = (pr.latestReviews || [])
    .map((r) => r.author?.login)
    .filter((x): x is string => Boolean(x));

  return {
    owner,
    repo,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    bodyText: pr.body || "",
    author: pr.author?.login || "unknown",
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    isDraft: pr.isDraft,
    mergeable: pr.mergeable || "UNKNOWN",
    labels: (pr.labels || []).map((x) => x.name),
    requestedReviewers,
    latestReviews: pr.latestReviews || [],
    // We intentionally do not request `files`; path filtering was removed.
    changedFiles: [],
    changedFileCount: pr.changedFiles || 0,
    // gh pr list can expose commits, but requesting it for many PRs may exceed GHE GraphQL limits.
    lastCommitAt: undefined,
    lastCommitMessage: "",
    // gh pr list does not expose reviewThreads. Keep this as 0 rather than doing per-PR extra requests.
    unresolvedThreadCount: 0,
    ciState: normalizeCiState(pr.statusCheckRollup || []),
    participants: unique([pr.author?.login, ...requestedReviewers, ...reviewAuthors]),
  };
}

function normalizeCiState(checks: GhStatusCheck[]): string {
  if (checks.length === 0) return "UNKNOWN";

  const values = checks.map((x) => (x.conclusion || x.state || x.status || "").toUpperCase());
  if (values.some((x) => ["FAILURE", "FAILED", "ERROR", "TIMED_OUT", "ACTION_REQUIRED", "CANCELLED"].includes(x))) {
    return "FAILURE";
  }
  if (values.some((x) => ["PENDING", "QUEUED", "IN_PROGRESS", "REQUESTED", "WAITING"].includes(x))) {
    return "EXPECTED";
  }
  if (values.some((x) => x === "SUCCESS")) {
    return "SUCCESS";
  }
  return "UNKNOWN";
}

function unique(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.filter((x): x is string => Boolean(x)))];
}
