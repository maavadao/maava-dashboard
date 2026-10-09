/**
 * Static map of skill-id patterns → required API connections.
 * Used to display connection requirements in the Skills UI and guide users
 * through configuring API keys before using skills that need them.
 *
 * Skills NOT in this map (weather, browser-use, web-search, calculator,
 * translator, timezone, regex, code-interpreter, etc.) work without any keys.
 */

export type ConnectionRequirement = {
  /** Environment variable name, e.g., 'GITHUB_TOKEN' */
  envKey: string;
  /** Human-readable label, e.g., 'GitHub Personal Access Token' */
  label: string;
  /** Short guidance on how to get this key */
  description: string;
  /** Input placeholder text */
  placeholder: string;
  /** Link to get or manage this key */
  link?: string;
  /** Whether this key is strictly required (vs. optional enhancement) */
  required: boolean;
};

/**
 * Map from normalized skill-id patterns to their required connections.
 * Keys are normalized (lowercase, underscores). Matched against skill_id values
 * in the database using exact or prefix matching.
 */
const SKILL_CONNECTIONS_MAP: Record<string, ConnectionRequirement[]> = {
  // ── Version Control ──────────────────────────────────────────────────────
  github: [
    {
      envKey: 'GITHUB_TOKEN',
      label: 'GitHub Personal Access Token',
      description: 'Create a PAT with repo/read:user scopes in GitHub Settings → Developer settings.',
      placeholder: 'ghp_xxxxxxxxxxxxxxxxxxxx',
      link: 'https://github.com/settings/tokens',
      required: true,
    },
  ],
  gitlab: [
    {
      envKey: 'GITLAB_TOKEN',
      label: 'GitLab Personal Access Token',
      description: 'Create a token with api scope in GitLab → User Settings → Access Tokens.',
      placeholder: 'glpat-xxxxxxxxxxxxxxxxxxxx',
      link: 'https://gitlab.com/-/profile/personal_access_tokens',
      required: true,
    },
  ],
  // ── Project Management ───────────────────────────────────────────────────
  jira: [
    {
      envKey: 'JIRA_API_TOKEN',
      label: 'Jira API Token',
      description: 'Generate an API token in Atlassian account settings.',
      placeholder: 'ATATxxxxxxxxxxx',
      link: 'https://id.atlassian.com/manage-profile/security/api-tokens',
      required: true,
    },
    {
      envKey: 'JIRA_BASE_URL',
      label: 'Jira Base URL',
      description: 'Your Jira instance URL, e.g., https://yourteam.atlassian.net',
      placeholder: 'https://yourteam.atlassian.net',
      required: true,
    },
    {
      envKey: 'JIRA_USER_EMAIL',
      label: 'Jira Account Email',
      description: 'The email address associated with your Jira account.',
      placeholder: 'you@company.com',
      required: true,
    },
  ],
  linear: [
    {
      envKey: 'LINEAR_API_KEY',
      label: 'Linear API Key',
      description: 'Create a personal API key in Linear → Settings → API.',
      placeholder: 'lin_api_xxxxxxxxxxxxxxxxxxxx',
      link: 'https://linear.app/settings/api',
      required: true,
    },
  ],
  asana: [
    {
      envKey: 'ASANA_PAT',
      label: 'Asana Personal Access Token',
      description: 'Create a PAT in Asana → My Profile Settings → Apps → Manage Developer Apps.',
      placeholder: '1/xxxxxxxxxxxxxxxx:xxxxxxxxxxxxxxxxxxxxxxxx',
      link: 'https://app.asana.com/0/developer-console',
      required: true,
    },
  ],
  clickup: [
    {
      envKey: 'CLICKUP_API_KEY',
      label: 'ClickUp API Key',
      description: 'Get your API key in ClickUp → Settings → Apps.',
      placeholder: 'pk_xxxxxxxxxxxx',
      link: 'https://app.clickup.com/settings/apps',
      required: true,
    },
  ],
  notion: [
    {
      envKey: 'NOTION_API_KEY',
      label: 'Notion Integration Token',
      description: 'Create an integration in Notion → Settings → Integrations and share pages with it.',
      placeholder: 'secret_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      link: 'https://www.notion.so/my-integrations',
      required: true,
    },
  ],
  // ── Communication ────────────────────────────────────────────────────────
  slack: [
    {
      envKey: 'SLACK_BOT_TOKEN',
      label: 'Slack Bot Token',
      description: 'Create a Slack app at api.slack.com, add bot scopes, and install to workspace.',
      placeholder: 'xoxb-xxxxxxxxxxxx-xxxxxxxxxxxx-xxxxxxxxxxxxxxxxxxxxxxxx',
      link: 'https://api.slack.com/apps',
      required: true,
    },
  ],
  discord: [
    {
      envKey: 'DISCORD_BOT_TOKEN',
      label: 'Discord Bot Token',
      description: 'Create a bot at Discord Developer Portal → Applications → Bot.',
      placeholder: 'MTxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      link: 'https://discord.com/developers/applications',
      required: true,
    },
  ],
  // Note: Telegram is a channel (connected via /channels/telegram), NOT a skill.
  // Users connect to the maavaDao Telegram bot — no bot token needed from the user.
  twilio: [
    {
      envKey: 'TWILIO_ACCOUNT_SID',
      label: 'Twilio Account SID',
      description: 'Found on your Twilio Console dashboard.',
      placeholder: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      link: 'https://console.twilio.com',
      required: true,
    },
    {
      envKey: 'TWILIO_AUTH_TOKEN',
      label: 'Twilio Auth Token',
      description: 'Found on your Twilio Console dashboard.',
      placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      link: 'https://console.twilio.com',
      required: true,
    },
    {
      envKey: 'TWILIO_PHONE_NUMBER',
      label: 'Twilio Phone Number',
      description: 'Your Twilio phone number in E.164 format, e.g., +15551234567.',
      placeholder: '+15551234567',
      required: false,
    },
  ],
  sendgrid: [
    {
      envKey: 'SENDGRID_API_KEY',
      label: 'SendGrid API Key',
      description: 'Create an API key in SendGrid → Settings → API Keys.',
      placeholder: 'SG.xxxxxxxxxxxxxxxxxxxx.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      link: 'https://app.sendgrid.com/settings/api_keys',
      required: true,
    },
  ],
  mailchimp: [
    {
      envKey: 'MAILCHIMP_API_KEY',
      label: 'Mailchimp API Key',
      description: 'Find or generate your API key in Mailchimp → Account → Extras → API keys.',
      placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx-us1',
      link: 'https://admin.mailchimp.com/account/api/',
      required: true,
    },
  ],
  // ── CRM & Sales ──────────────────────────────────────────────────────────
  hubspot: [
    {
      envKey: 'HUBSPOT_ACCESS_TOKEN',
      label: 'HubSpot Private App Token',
      description: 'Create a Private App in HubSpot → Settings → Integrations → Private Apps.',
      placeholder: 'pat-na1-xxxxxxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
      link: 'https://app.hubspot.com/private-apps',
      required: true,
    },
  ],
  salesforce: [
    {
      envKey: 'SALESFORCE_ACCESS_TOKEN',
      label: 'Salesforce Access Token',
      description: 'OAuth access token from your Salesforce Connected App.',
      placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      required: true,
    },
    {
      envKey: 'SALESFORCE_INSTANCE_URL',
      label: 'Salesforce Instance URL',
      description: 'Your Salesforce instance URL, e.g., https://yourorg.salesforce.com',
      placeholder: 'https://yourorg.salesforce.com',
      required: true,
    },
  ],
  // ── Payments ─────────────────────────────────────────────────────────────
  stripe: [
    {
      envKey: 'STRIPE_SECRET_KEY',
      label: 'Stripe Secret Key',
      description: 'Get your secret key from Stripe Dashboard → Developers → API keys.',
      placeholder: 'sk_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      link: 'https://dashboard.stripe.com/apikeys',
      required: true,
    },
  ],
  // ── Search ───────────────────────────────────────────────────────────────
  brave: [
    {
      envKey: 'BRAVE_API_KEY',
      label: 'Brave Search API Key',
      description: 'Get a Brave Search API key from brave.com/search/api. Free tier available; falls back to DuckDuckGo without it.',
      placeholder: 'BSAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      link: 'https://api.search.brave.com/',
      required: false,
    },
  ],
  perplexity: [
    {
      envKey: 'PERPLEXITY_API_KEY',
      label: 'Perplexity API Key',
      description: 'Get your API key from Perplexity → Settings → API.',
      placeholder: 'pplx-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      link: 'https://www.perplexity.ai/settings/api',
      required: true,
    },
  ],
  // ── Maps & Location ──────────────────────────────────────────────────────
  google_maps: [
    {
      envKey: 'GOOGLE_MAPS_API_KEY',
      label: 'Google Maps API Key',
      description: 'Create an API key in Google Cloud Console with Maps JavaScript API enabled.',
      placeholder: 'AIzaxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      link: 'https://console.cloud.google.com/apis/credentials',
      required: true,
    },
  ],
  // ── Design ───────────────────────────────────────────────────────────────
  figma: [
    {
      envKey: 'FIGMA_ACCESS_TOKEN',
      label: 'Figma Personal Access Token',
      description: 'Generate a token in Figma → Account Settings → Personal access tokens.',
      placeholder: 'figd_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      link: 'https://www.figma.com/settings',
      required: true,
    },
  ],
  // ── Databases & Storage ──────────────────────────────────────────────────
  airtable: [
    {
      envKey: 'AIRTABLE_API_KEY',
      label: 'Airtable Personal Access Token',
      description: 'Create a token in Airtable → Account → Developer hub → Personal access tokens.',
      placeholder: 'patxxxxxxxxxxxxxxxx.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      link: 'https://airtable.com/create/tokens',
      required: true,
    },
    {
      envKey: 'AIRTABLE_BASE_ID',
      label: 'Airtable Base ID',
      description: 'Found in your Airtable base URL: airtable.com/appXXXXXXXX',
      placeholder: 'appxxxxxxxxxxxxxxxxxxxxxxxx',
      required: false,
    },
  ],
  supabase: [
    {
      envKey: 'SUPABASE_URL',
      label: 'Supabase Project URL',
      description: 'Your Supabase project URL from Settings → API.',
      placeholder: 'https://xxxxxxxxxxxx.supabase.co',
      link: 'https://supabase.com/dashboard/project/_/settings/api',
      required: true,
    },
    {
      envKey: 'SUPABASE_SERVICE_KEY',
      label: 'Supabase Service Role Key',
      description: 'Service role key from Settings → API (keep secret!).',
      placeholder: 'eyJxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      required: true,
    },
  ],
  mongodb: [
    {
      envKey: 'MONGODB_URI',
      label: 'MongoDB Connection URI',
      description: 'Your MongoDB Atlas connection string from Connect → Drivers.',
      placeholder: 'mongodb+srv://user:pass@cluster.xxxxx.mongodb.net/dbname',
      link: 'https://cloud.mongodb.com',
      required: true,
    },
  ],
  redis: [
    {
      envKey: 'REDIS_URL',
      label: 'Redis Connection URL',
      description: 'Your Redis connection URL, e.g., from Upstash or Redis Cloud.',
      placeholder: 'redis://user:password@host:6379',
      required: true,
    },
  ],
  firebase: [
    {
      envKey: 'FIREBASE_SERVICE_ACCOUNT',
      label: 'Firebase Service Account JSON',
      description: 'Download service account JSON from Firebase Console → Project Settings → Service Accounts.',
      placeholder: '{"type":"service_account","project_id":"..."}',
      link: 'https://console.firebase.google.com',
      required: true,
    },
  ],
  // ── Commerce ─────────────────────────────────────────────────────────────
  shopify: [
    {
      envKey: 'SHOPIFY_ACCESS_TOKEN',
      label: 'Shopify Admin API Access Token',
      description: 'Create a custom app in Shopify Partners and get the access token.',
      placeholder: 'shpat_xxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      required: true,
    },
    {
      envKey: 'SHOPIFY_SHOP_DOMAIN',
      label: 'Shop Domain',
      description: 'Your Shopify shop domain, e.g., yourshop.myshopify.com',
      placeholder: 'yourshop.myshopify.com',
      required: true,
    },
  ],
  spotify: [
    {
      envKey: 'SPOTIFY_CLIENT_ID',
      label: 'Spotify Client ID',
      description: 'Get credentials from Spotify Developer Dashboard → Your App.',
      placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      link: 'https://developer.spotify.com/dashboard',
      required: true,
    },
    {
      envKey: 'SPOTIFY_CLIENT_SECRET',
      label: 'Spotify Client Secret',
      description: 'Your Spotify app client secret from the Dashboard.',
      placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      link: 'https://developer.spotify.com/dashboard',
      required: true,
    },
  ],
  // ── Cloud & Infrastructure ───────────────────────────────────────────────
  aws: [
    {
      envKey: 'AWS_ACCESS_KEY_ID',
      label: 'AWS Access Key ID',
      description: 'Create access keys in AWS IAM → Users → Security credentials.',
      placeholder: 'AKIAxxxxxxxxxxxxxxxx',
      link: 'https://console.aws.amazon.com/iam/home#/users',
      required: true,
    },
    {
      envKey: 'AWS_SECRET_ACCESS_KEY',
      label: 'AWS Secret Access Key',
      description: 'Your AWS secret access key (only shown once at creation).',
      placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      required: true,
    },
  ],
  // ── DevOps & Monitoring ──────────────────────────────────────────────────
  sentry: [
    {
      envKey: 'SENTRY_AUTH_TOKEN',
      label: 'Sentry Auth Token',
      description: 'Create an auth token in Sentry → Settings → Auth Tokens.',
      placeholder: 'sntrys_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      link: 'https://sentry.io/settings/auth-tokens/',
      required: true,
    },
  ],
  datadog: [
    {
      envKey: 'DATADOG_API_KEY',
      label: 'Datadog API Key',
      description: 'Create an API key in Datadog → Organization Settings → API Keys.',
      placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      link: 'https://app.datadoghq.com/organization-settings/api-keys',
      required: true,
    },
  ],
  // ── Code Execution ───────────────────────────────────────────────────────
  e2b: [
    {
      envKey: 'E2B_API_KEY',
      label: 'E2B API Key',
      description: 'Get your API key from e2b.dev dashboard.',
      placeholder: 'e2b_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      link: 'https://e2b.dev/dashboard',
      required: true,
    },
  ],
  // ── Bundled Skill API Keys ───────────────────────────────────────────────
  // These match the env vars declared in the bundled SKILL.md files under
  // tenant-platform/skills/*/SKILL.md (metadata.openclaw.requires.env).
  goplaces: [
    {
      envKey: 'GOOGLE_PLACES_API_KEY',
      label: 'Google Places API Key',
      description: 'Enable the Places API in Google Cloud Console and create an API key.',
      placeholder: 'AIzaxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      link: 'https://console.cloud.google.com/apis/library/places-backend.googleapis.com',
      required: true,
    },
  ],
  local_places: [
    {
      envKey: 'GOOGLE_PLACES_API_KEY',
      label: 'Google Places API Key',
      description: 'Enable the Places API in Google Cloud Console and create an API key.',
      placeholder: 'AIzaxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      link: 'https://console.cloud.google.com/apis/library/places-backend.googleapis.com',
      required: true,
    },
  ],
  openai_image_gen: [
    {
      envKey: 'OPENAI_API_KEY',
      label: 'OpenAI API Key',
      description: 'Used for DALL·E image generation. Get your key from the OpenAI dashboard.',
      placeholder: 'sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      link: 'https://platform.openai.com/api-keys',
      required: true,
    },
  ],
  openai_whisper_api: [
    {
      envKey: 'OPENAI_API_KEY',
      label: 'OpenAI API Key',
      description: 'Used for Whisper speech-to-text API. Get your key from the OpenAI dashboard.',
      placeholder: 'sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      link: 'https://platform.openai.com/api-keys',
      required: true,
    },
  ],
  nano_banana_pro: [
    {
      envKey: 'GEMINI_API_KEY',
      label: 'Google Gemini API Key',
      description: 'Get a Gemini API key from Google AI Studio.',
      placeholder: 'AIzaxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      link: 'https://aistudio.google.com/apikey',
      required: true,
    },
  ],
  sag: [
    {
      envKey: 'ELEVENLABS_API_KEY',
      label: 'ElevenLabs API Key',
      description: 'Get your API key from the ElevenLabs dashboard.',
      placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      link: 'https://elevenlabs.io/app/settings/api-keys',
      required: true,
    },
  ],
  trello: [
    {
      envKey: 'TRELLO_API_KEY',
      label: 'Trello API Key',
      description: 'Get your API key from the Trello Power-Up Admin Portal.',
      placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      link: 'https://trello.com/power-ups/admin',
      required: true,
    },
    {
      envKey: 'TRELLO_TOKEN',
      label: 'Trello Token',
      description: 'Authorize your app and get a token via the Trello API.',
      placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      link: 'https://trello.com/power-ups/admin',
      required: true,
    },
  ],
  sherpa_onnx_tts: [
    {
      envKey: 'SHERPA_ONNX_RUNTIME_DIR',
      label: 'Sherpa-ONNX Runtime Directory',
      description: 'Path to the extracted sherpa-onnx shared library directory.',
      placeholder: '/opt/sherpa-onnx/lib',
      required: true,
    },
    {
      envKey: 'SHERPA_ONNX_MODEL_DIR',
      label: 'Sherpa-ONNX Model Directory',
      description: 'Path to the TTS model directory (e.g. vits-piper-en_US-lessac-high).',
      placeholder: '/opt/sherpa-onnx/models/vits-piper-en_US-lessac-high',
      required: true,
    },
  ],
  // ── Social Media ─────────────────────────────────────────────────────────
  twitter: [
    {
      envKey: 'TWITTER_API_KEY',
      label: 'Twitter/X API Key',
      description: 'Create a project and app in Twitter Developer Portal.',
      placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      link: 'https://developer.twitter.com/en/portal/dashboard',
      required: true,
    },
    {
      envKey: 'TWITTER_API_SECRET',
      label: 'Twitter/X API Secret',
      description: 'Your Twitter app API secret key.',
      placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      required: true,
    },
  ],
};

/**
 * Get connection requirements for a given skill ID.
 * Uses normalized matching: lowercase, dashes/spaces → underscores.
 * Returns empty array for skills that work without API keys.
 */
export function getSkillConnectionRequirements(skillId: string): ConnectionRequirement[] {
  const normalized = skillId.toLowerCase().replace(/[-\s]/g, '_');

  // Exact match
  if (SKILL_CONNECTIONS_MAP[normalized]) return SKILL_CONNECTIONS_MAP[normalized];

  // Prefix match: skill id starts with a known key (e.g., 'github_repo_manager' → 'github')
  for (const [key, reqs] of Object.entries(SKILL_CONNECTIONS_MAP)) {
    if (normalized.startsWith(key + '_') || key.startsWith(normalized + '_')) return reqs;
  }

  return [];
}
