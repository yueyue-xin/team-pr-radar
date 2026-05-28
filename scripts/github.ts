import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import type { LatestReview, NormalizedPR, RadarConfig } from "./types.js";

const GITHUB_API = "https://api.github.com/graphql";
const execFile = promisify(execFileCallback);

function githubApiUrl(host: string): string {
  return host === "github.com"
    ? "https://api.github.com/graphql"
    : `https://${host}/api/graphql`;
}

const OPEN_PRS_QUERY = `
query OpenPullRequests($owner: String!, $repo: String!, $first: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequests(first: $first, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number
        title
        url
        bodyText
        createdAt
        updatedAt
        isDraft
        mergeable
        author { login }
        labels(first: 20) { nodes { name } }
        commits(last: 1) { nodes { commit { committedDate oid messageHeadline } } }
        files(first: 30) { totalCount nodes { path } }
        reviewRequests(first: 20) {
          nodes { requestedReviewer { ... on User { login } ... on Team { name } } }
        }
        reviews(first: 50, states: [APPROVED, CHANGES_REQUESTED, COMMENTED]) {
          nodes {
            state
            submittedAt
            author { login }
          }
        }
        reviewThreads(first: 50) {
          nodes { isResolved }
        }
        statusCheckRollup {
          state
        }
      }
    }
  }
}
`;

interface GithubGraphqlResponse {
  repository: {
    pullRequests: {
      nodes: GithubPullRequestNode[];
    };
  };
}

interface GithubPullRequestNode {
  number: number;
  title: string;
  url: string;
  bodyText?: string | null;
  createdAt: string;
  updatedAt: string;
  isDraft: boolean;
  mergeable: string;
  author?: { login?: string | null } | null;
  labels: { nodes: Array<{ name: string }> };
  commits: { nodes: Array<{ commit: { committedDate: string; oid: string; messageHeadline: string } }> };
  files: { totalCount: number; nodes: Array<{ path: string }> };
  reviewRequests: {
    nodes: Array<{
      requestedReviewer?: { login?: string | null; name?: string | null } | null;
    }>;
  };
  reviews: { nodes: LatestReview[] };
  reviewThreads: { nodes: Array<{ isResolved: boolean }> };
  statusCheckRollup?: { state: string } | null;
}

async function githubGraphql<T>(query: string, variables: Record<string, unknown>, host: string): Promise<T> {
  const token = await getGithubToken(host);

  const response = await fetch(githubApiUrl(host), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "team-pr-radar",
    },
    body: JSON.stringify({ query, variables }),
  });

  const payload = (await response.json()) as { data?: T; errors?: unknown };
  if (!response.ok || payload.errors || !payload.data) {
    throw new Error(`GitHub GraphQL failed: ${JSON.stringify(payload.errors || payload)}`);
  }
  return payload.data;
}

async function getGithubToken(host: string): Promise<string> {
  const envToken = process.env.PR_RADAR_GITHUB_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (envToken) return envToken.trim();

  try {
    const args = host === "github.com" ? ["auth", "token"] : ["auth", "token", "--hostname", host];
    const { stdout } = await execFile("gh", args, { timeout: 5000 });
    const token = stdout.trim();
    if (token) return token;
  } catch {
    // Ignore and throw a clearer error below.
  }

  throw new Error(
    `GitHub token is required. Set PR_RADAR_GITHUB_TOKEN/GITHUB_TOKEN/GH_TOKEN, or run \`gh auth login --hostname ${host}\` locally.`
  );
}

export async function fetchOpenPRs(config: RadarConfig): Promise<NormalizedPR[]> {
  const { org, repos, host } = config.github;
  const first = config.rules.max_open_prs_per_repo;
  const all: NormalizedPR[] = [];

  for (const repo of repos) {
    const data = await githubGraphql<GithubGraphqlResponse>(OPEN_PRS_QUERY, { owner: org, repo, first }, host);
    const prs = data.repository.pullRequests.nodes.map((pr) => normalizePR(org, repo, pr));
    all.push(...prs);
  }

  return all;
}

function normalizePR(owner: string, repo: string, pr: GithubPullRequestNode): NormalizedPR {
  const reviews = pr.reviews.nodes || [];
  const latestReviewByUser = new Map<string, LatestReview>();
  for (const review of reviews) {
    const login = review.author?.login;
    if (!login) continue;
    const prev = latestReviewByUser.get(login);
    if (!prev || new Date(review.submittedAt) > new Date(prev.submittedAt)) {
      latestReviewByUser.set(login, review);
    }
  }
  const latestReviews = [...latestReviewByUser.values()];

  return {
    owner,
    repo,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    bodyText: pr.bodyText || "",
    author: pr.author?.login || "unknown",
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    isDraft: pr.isDraft,
    mergeable: pr.mergeable,
    labels: (pr.labels.nodes || []).map((x) => x.name),
    requestedReviewers: (pr.reviewRequests.nodes || [])
      .map((x) => x.requestedReviewer?.login || x.requestedReviewer?.name)
      .filter((x): x is string => Boolean(x)),
    latestReviews,
    changedFiles: (pr.files.nodes || []).map((x) => x.path),
    changedFileCount: pr.files.totalCount || 0,
    lastCommitAt: pr.commits.nodes?.[0]?.commit?.committedDate,
    lastCommitMessage: pr.commits.nodes?.[0]?.commit?.messageHeadline || "",
    unresolvedThreadCount: (pr.reviewThreads.nodes || []).filter((x) => !x.isResolved).length,
    ciState: pr.statusCheckRollup?.state || "UNKNOWN",
  };
}
