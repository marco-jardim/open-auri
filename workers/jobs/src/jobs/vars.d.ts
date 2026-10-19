// Plain vars of the jobs Worker read by the jobs themselves (wrangler.template.jsonc `vars`).
// `wrangler types --strict-vars=false` (npm run gen) declares them too, with the same type; they
// are repeated here so the jobs type-check against a worker-configuration.d.ts generated before
// the var existed (merged into the generated Env interfaces).

interface Env {
  /** The web Worker's YOLO kill switch (`off` | `on`; see src/jobs/og-sweep.ts). */
  YOLO_PUBLICATION: string;
}

declare namespace Cloudflare {
  interface Env {
    YOLO_PUBLICATION: string;
  }
}
