import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  // Standalone output is required by the container: it emits a self-contained
  // `.next/standalone` directory (with its own minimal node_modules) plus a
  // `server.js`, so the runtime image does not need a full install.
  output: "standalone",

  // The browser E2E spec serves the app on 127.0.0.1:3101 (see playwright.config.ts).
  // Next's dev server considers its canonical origin to be `localhost`, so a page
  // loaded from 127.0.0.1 is treated as cross-origin: dev resources (HMR, overlay)
  // are blocked and the client bundle never hydrates. Allow the loopback address
  // explicitly so the app hydrates and the login flow works in the browser checks.
  allowedDevOrigins: ["127.0.0.1"],

  // The Prisma client loads its native query-engine binary lazily at runtime.
  // Output-file tracing does not always see that dynamic require, so include the
  // generated client's engine directory explicitly. Without this the image can
  // build but crash at runtime with "query engine not found".
  outputFileTracingIncludes: {
    "/*": ["./node_modules/.prisma/client/**/*"],
  },
}

export default nextConfig
