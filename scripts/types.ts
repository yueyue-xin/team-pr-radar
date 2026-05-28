export type ReviewState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | string;

export type PullRequestStatus =
  | "ready_for_review"
  | "needs_reviewer"
  | "re_review_needed"
  | "author_action_needed"
  | "approved_waiting_merge";

export interface RadarConfig {
  github: {
    host: string;
    org: string;
    repos: string[];
  };
  filters: {
    labels: {
      include: string[];
      exclude: string[];
    };
    reviewers: {
      include: string[];
      exclude: string[];
    };
    paths: {
      include: string[];
      exclude: string[];
    };
  };
  rules: {
    ignore_draft: boolean;
    stale_after_hours: number;
    urgent_after_hours: number;
    max_open_prs_per_repo: number;
    max_prs_in_brief: number;
    max_prs_to_ai_summarize: number;
    include_approved_waiting_merge: boolean;
  };
  ai: {
    enabled: boolean;
    model: string;
  };
  chat: {
    title: string;
    timezone: string;
  };
}

export interface LatestReview {
  state: ReviewState;
  submittedAt: string;
  author?: {
    login?: string;
  } | null;
}

export interface NormalizedPR {
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  bodyText: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  isDraft: boolean;
  mergeable: string;
  labels: string[];
  requestedReviewers: string[];
  latestReviews: LatestReview[];
  changedFiles: string[];
  changedFileCount: number;
  lastCommitAt?: string;
  lastCommitMessage: string;
  unresolvedThreadCount: number;
  ciState: string;
}

export interface ClassifiedPR extends NormalizedPR {
  status: PullRequestStatus;
  currentOwner: string;
  waitingFor: string[];
  waitingSince: string;
  waitingHours: number;
  stale: boolean;
  urgent: boolean;
  ciFailed: boolean;
  hasUnresolvedThreads: boolean;
  reason: string;
  priorityScore: number;
  aiNote: string;
}
