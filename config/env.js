import { existsSync } from 'node:fs';

export function loadDotEnv(path = '.env') {
  if (existsSync(path)) process.loadEnvFile(path); // built into Node >= 20.12
}

const int = (x, d) => (Number.isFinite(parseInt(x, 10)) ? parseInt(x, 10) : d);

export function loadConfig(env = process.env, overrides = {}) {
  const production = env.NODE_ENV === 'production';
  const config = {
    production,
    host: env.HOST || (env.RENDER ? '0.0.0.0' : '127.0.0.1'), // Render sets RENDER=true and can only reach 0.0.0.0
    port: int(env.PORT, 3000),
    trustProxy: env.TRUST_PROXY === 'true',
    allowedOrigins: (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    storage: {
      driver: env.STORAGE_DRIVER || 'sqlite', sqlitePath: env.SQLITE_PATH || './data/universe.db',
      github: { // only used when STORAGE_DRIVER=github
        token: env.GITHUB_TOKEN || '', repo: env.GITHUB_REPO || '', branch: env.GITHUB_BRANCH || 'universe-data',
        path: env.GITHUB_DATA_PATH || 'universe-data.json', flushMs: int(env.GITHUB_FLUSH_MS, 3000),
        serverless: env.VERCEL === '1' || env.GITHUB_SERVERLESS === 'true',
        ephemeral: (env.GITHUB_EPHEMERAL_COLLECTIONS || '').split(',').map((s) => s.trim()).filter(Boolean),
      },
    },
    cloudinary: { cloudName: env.CLOUDINARY_CLOUD_NAME || '', uploadPreset: env.CLOUDINARY_UPLOAD_PRESET || '' },
    ai: { defaultProvider: env.AI_DEFAULT_PROVIDER || 'groq', defaultModel: env.AI_DEFAULT_MODEL || '', sharedKeys: { groq: env.GROQ_API_KEY || '' },
      keyEncryptionSecret: env.KEY_ENCRYPTION_SECRET || '', groqBaseUrl: env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1' },
    session: { ttlHours: int(env.SESSION_TTL_HOURS, 168) },
    finance: { secret: env.FINANCE_SECRET || "" }, // optional; Orbit falls back to KEY_ENCRYPTION_SECRET
    // Public sign-up. New accounts get SIGNUP_ROLE and, unless SIGNUP_ALLOW_AI=true, no access to the shared AI key.
    signup: { enabled: env.SIGNUP_ENABLED !== 'false', roleId: env.SIGNUP_ROLE || 'resident', allowAi: env.SIGNUP_ALLOW_AI === 'true' },
    bootstrap: { email: env.BOOTSTRAP_ADMIN_EMAIL || '', password: env.BOOTSTRAP_ADMIN_PASSWORD || '' },
    rateLimits: {
      global: { windowMs: 60_000, max: 300 },
      loginIp: { windowMs: 15 * 60_000, max: 30 },
      loginEmail: { windowMs: 15 * 60_000, max: 5 }, // failed attempts per email
      ai: { windowMs: 60_000, max: 20 }, // chat requests per user per minute
      signup: { windowMs: 60 * 60_000, max: 10 }, // new accounts per IP per hour
    },
  };
  return { ...config, ...overrides, rateLimits: { ...config.rateLimits, ...(overrides.rateLimits || {}) } };
}
