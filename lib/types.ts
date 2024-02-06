export type Config = {
  name: string;
  description: string;
  maintainers: string[];
  clawback?: boolean; // removes assigned issues from github if not resolved in time
  private?: boolean;
  channels?: {
    grouping?: { minutes: number };
    id: string;
    name: string;
    sla: { responseTime: number };
  }[];
  repos: {
    uri: string;
    sla: { responseTime: number };
  }[];
  resources?: {
    name: string;
    uri: string;
  }[];
  sections?: {
    name: string;
    pattern: string;
  }[];
};

export type Maintainer = { id: string; slack: string; github: string };

export type GithubData = {
  repository: {
    issues: IssueOrPull;
    pullRequests: IssueOrPull;
  };
};

export type IssueOrPull = {
  nodes: {
    id: string;
    number: number;
    title: string;
    bodyText: string;
    createdAt: string;
    updatedAt: string;
    author: {
      login: string;
    };
    labels: {
      nodes: {
        name: string;
      }[];
    };
    assignees: {
      nodes: {
        login: string;
        createdAt: string;
      }[];
    };
    participants: {
      nodes: {
        login: string;
      }[];
    };
    comments: {
      totalCount: number;
      nodes: {
        author: {
          resourcePath: string;
          login: string;
        };
        createdAt: string;
      }[];
    };
    timelineItems: { edges: { node: { createdAt: string } }[] };
  }[];
};

export type SingleIssueOrPullData = {
  node: {
    id: string;
    number: number;
    title: string;
    bodyText: string;
    closedAt: string;
    assignees: {
      nodes: {
        login: string;
        createdAt: string;
      }[];
    };
    labels: {
      nodes: {
        name: string;
      }[];
    };
    participants: {
      nodes: {
        login: string;
      }[];
    };
    comments: {
      totalCount: number;
      nodes: {
        author: {
          resourcePath: string;
          login: string;
        };
        createdAt: string;
      }[];
    };
    timelineItems: { edges: { node: { createdAt: string } }[] };
  };
};

export enum State {
  open = "open",
  triaged = "triaged",
  resolved = "resolved",
  snoozed = "snoozed",
}

export enum ItemType {
  issue = "issue",
  pull = "pull",
  message = "message",
  followUp = "followUp",
}

export type ElasticDocument = {
  id?: string;
  author?: {
    displayName: string;
    github: string | null;
    slack: string | null;
  };
  state?: State;
  project?: string;
  source?: string;
  actionItemType?: ItemType;
  followUpDuration?: number;
  followUpTo?: string;
  createdTime?: Date;
  resolvedTime?: Date | null;
  reason?: string;
  firstResponseTime?: Date | null;
  lastModifiedTime?: Date;
  snoozedUntil?: Date | null;
  timesSnoozed?: number;
  timesReopened?: number;
  timesResolved?: number;
  timesCommented?: number;
  timesAssigned?: number;
  firstResponseTimeInS?: number | null;
  resolutionTimeInS?: number | null;
  assignee?: {
    displayName: string;
    github: string | null;
    slack: string | null;
  };
  actors?: {
    displayName: string;
    github: string | null;
    slack: string | null;
  }[];
  url?: string;
};
