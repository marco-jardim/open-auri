// Secrets of the jobs Worker (tools/render-wrangler.mjs SECRETS with workers: 'jobs'). They are
// absent from worker-configuration.d.ts unless `wrangler types` runs with a filled .dev.vars, so
// they are declared here (merged into the generated Env interfaces).

interface Env {
  /** Access-log keyring (`kid:secret[,kid:secret...]`, see ./access-log-crypto.js). */
  ACCESS_LOG_KEY: string;
}

declare namespace Cloudflare {
  interface Env {
    ACCESS_LOG_KEY: string;
  }
}
