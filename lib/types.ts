export type Config = {
  name: string;
  description: string;
  maintainers: string[];
  channels?: {
    id: string;
    name: string;
    sla: { responseTime: number };
    owners?: SubsectionOwner;
  }[];
  repos: {
    uri: string;
    sla: { responseTime: number };
    owners?: SubsectionOwner;
  }[];
};

type SubsectionOwner = {
  default: string[];
  subsections?: {
    owners: string[];
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
    closedAt: string;
    assignees: {
      nodes: {
        login: string;
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
