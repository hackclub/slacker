export type Config = {
  result: {
    data: {
      name: string;
      description: string;
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
  };
};
