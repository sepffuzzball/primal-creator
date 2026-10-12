/**
 * Liveness / readiness endpoint.
 *
 * Deliberately does NOT touch the database: the container healthcheck must pass
 * even while Postgres is still coming up or is temporarily unreachable, so
 * orchestration can observe that the app process is alive without coupling the
 * app's life to the database's. Database availability is verified explicitly by
 * the migration/seed step, not by the web process.
 *
 * Uses the Node.js runtime, matching the other route handlers.
 */

export const runtime = "nodejs"

export async function GET() {
  return Response.json({
    status: "ok",
    service: "primal-creator",
  })
}
