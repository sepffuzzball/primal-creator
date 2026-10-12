import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  // Standalone output is required by the container: it emits a self-contained
  // `.next/standalone` directory (with its own minimal node_modules) plus a
  // `server.js`, so the runtime image does not need a full install.
  output: "standalone",

  // The Prisma client loads its native query-engine binary lazily at runtime.
  // Output-file tracing does not always see that dynamic require, so include the
  // generated client's engine directory explicitly. Without this the image can
  // build but crash at runtime with "query engine not found".
  outputFileTracingIncludes: {
    "/*": ["./node_modules/.prisma/client/**/*"],
  },
}

export default nextConfig
