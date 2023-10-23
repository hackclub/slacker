export type Config = {
  name: string;
  description: string;
  maintainers: string[];
  "slack-channels": {
    id: string;
    name: string;
    sla: { responseTime: number };
  }[];
  repos: {
    uri: string;
    sla: { responseTime: number };
  }[];
};
