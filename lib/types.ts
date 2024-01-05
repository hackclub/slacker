export type Config = {
  name: string;
  description: string;
  maintainers: string[];
  clawback?: boolean;
  channels?: {
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
          login: string;
        };
        createdAt: string;
      }[];
    };
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
          login: string;
        };
        createdAt: string;
      }[];
    };
  };
};

export type ElasticDocument = {
  id?: string;
  author?: {
    displayName: string;
    github: string | null;
    slack: string | null;
  };
  state?: "open" | "triaged" | "resolved" | "snoozed";
  project?: string;
  source?: string;
  actionItemType?: "issue" | "pull" | "message";
  createdTime?: Date;
  resolvedTime?: Date | null;
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
