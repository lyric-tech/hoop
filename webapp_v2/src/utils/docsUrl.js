// Single source of truth for documentation URLs — mirrors webapp/src/webapp/config.cljs docs-url
export const docsUrl = {
  concepts: {
    agents: 'https://docs.lyric.tech/access/concepts/agents',
    connections: 'https://docs.lyric.tech/access/concepts/connections',
  },
  features: {
    runbooks: 'https://docs.lyric.tech/access/learn/features/runbooks',
    sessionRecording: 'https://docs.lyric.tech/access/learn/features/session-recording',
    aiDatamasking: 'https://docs.lyric.tech/access/learn/features/ai-data-masking',
    aiSessionAnalyzer: 'https://docs.lyric.tech/access/learn/features/ai-session-analyzer',
    attributes: 'https://docs.lyric.tech/access/learn/features/attributes',
    accessControl: 'https://docs.lyric.tech/access/learn/features/access-control',
    // Not in config.cljs — the CLJS access request page linked to :reviews
    // for want of a better key. Don't delete this as mirror drift.
    accessRequests: 'https://docs.lyric.tech/access/learn/features/access-requests/action',
    reviews: 'https://docs.lyric.tech/access/learn/features/reviews/overview',
    jitReviews: 'https://docs.lyric.tech/access/learn/features/reviews/jit-reviews',
    commandReviews: 'https://docs.lyric.tech/access/learn/features/reviews/command-reviews',
    guardrails: 'https://docs.lyric.tech/access/learn/features/guardrails',
  },
  introduction: {
    gettingStarted: 'https://docs.lyric.tech/access/introduction/getting-started',
  },
  quickstart: {
    databases: 'https://docs.lyric.tech/access/quickstart/databases',
    cloudServices: 'https://docs.lyric.tech/access/quickstart/cloud-services',
    webApplications: 'https://docs.lyric.tech/access/quickstart/web-applications',
    developmentEnvironments: 'https://docs.lyric.tech/access/quickstart/development-environments',
    ssh: 'https://docs.lyric.tech/access/quickstart/ssh',
  },
  setup: {
    agents: 'https://docs.lyric.tech/access/setup/agents',
    architecture: 'https://docs.lyric.tech/access/setup/architecture',
    deployment: {
      overview: 'https://docs.lyric.tech/access/setup/deployment',
      kubernetes: 'https://docs.lyric.tech/access/setup/deployment/kubernetes',
      docker: 'https://docs.lyric.tech/access/setup/deployment/docker-compose',
      aws: 'https://docs.lyric.tech/access/setup/deployment/AWS',
      onPremises: 'https://docs.lyric.tech/access/setup/deployment/on-premises',
    },
    configuration: {
      overview: 'https://docs.lyric.tech/access/setup/configuration',
      environmentVariables: 'https://docs.lyric.tech/access/setup/configuration/environment-variables',
      reverseProxy: 'https://docs.lyric.tech/access/setup/configuration/reverse-proxy',
      identityProviders: 'https://docs.lyric.tech/access/setup/configuration/idp/get-started',
      secretsManager: 'https://docs.lyric.tech/access/setup/configuration/secrets-manager-configuration',
      aiDataMasking: 'https://docs.lyric.tech/access/setup/configuration/ai-data-masking',
      rdsIamAuth: 'https://docs.lyric.tech/access/setup/configuration/rds-iam-auth',
    },
    apis: {
      apiKeys: 'https://docs.lyric.tech/access/setup/apis/api-key#api-key',
      overview: 'https://docs.lyric.tech/access/setup/apis',
    },
    licenseManagement: 'https://docs.lyric.tech/access/setup/license-management',
  },
  clients: {
    webApp: {
      overview: 'https://docs.lyric.tech/access/clients/webapp/overview',
      creatingConnection: 'https://docs.lyric.tech/access/clients/webapp/creating-connection',
      managingAccess: 'https://docs.lyric.tech/access/clients/webapp/managing-accesss',
      userManagement: 'https://docs.lyric.tech/access/clients/webapp/managing-accesss',
      monitoringSessions: 'https://docs.lyric.tech/access/clients/webapp/monitoring-sessions',
    },
    commandLine: {
      overview: 'https://docs.lyric.tech/access/clients/cli',
      windows: 'https://docs.lyric.tech/access/clients/cli#windows',
      macos: 'https://docs.lyric.tech/access/clients/cli#mac-os',
      linux: 'https://docs.lyric.tech/access/clients/cli#linux',
      managingConfiguration: 'https://docs.lyric.tech/access/clients/cli#managing-configuration',
    },
  },
  integrations: {
    slack: 'https://docs.lyric.tech/access/integrations/slack',
    teams: 'https://docs.lyric.tech/access/integrations/teams',
    jira: 'https://docs.lyric.tech/access/integrations/jira',
    svix: 'https://docs.lyric.tech/access/integrations/svix',
    awsConnect: 'https://docs.lyric.tech/access/integrations/aws',
  },
}
