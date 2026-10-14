import { z } from "zod"
import { Prisma } from "@prisma/client"
import { requireAdmin } from "@/lib/auth/guard"
import { prisma } from "@/lib/db/client"
import {
  houseRulesConfigSchema,
  HOUSE_RULES_ID,
  loadHouseRules,
} from "@/lib/db/ruleset"
import { ApiError, badRequest, conflict, respond } from "@/lib/server/errors"

export const runtime = "nodejs"

/**
 * Server-wide house-rules singleton (admin-only).
 *
 * GET returns the current validated `{version, config, updatedAt}` so the admin
 * Settings form can render and hold a CAS snapshot. PATCH applies a full new
 * `{version, config}` using `updateMany` keyed on `id = 'active'` AND the
 * supplied version, incrementing `version`; a stale version is a 409 (the
 * transport of an optimistic-concurrency conflict, never silently clobbered), a
 * missing row is an explicit 503 (the app never falls back to an in-memory
 * default), a malformed config is a 400.
 *
 * `config` is the FULL validated shape - NOT a partial patch. Omitting a field
 * would be a 400.
 */
const patchSchema = z
  .object({
    version: z.number().int().nonnegative(),
    config: houseRulesConfigSchema,
  })
  .strict()

export async function GET(req: Request) {
  return respond(async () => {
    await requireAdmin(req)
    // `loadHouseRules` throws a 503 `ruleset_unavailable` when the singleton row
    // is missing, so the app never silently falls back to an in-memory default.
    const houseRules = await loadHouseRules(prisma)
    return Response.json({
      version: houseRules.version,
      config: houseRules.config,
      updatedAt: houseRules.updatedAt.toISOString(),
    })
  })
}

export async function PATCH(req: Request) {
  return respond(async () => {
    await requireAdmin(req)
    const body = await req.json().catch(() => null)
    const parsed = patchSchema.safeParse(body)
    if (!parsed.success) {
      throw badRequest(
        "validation",
        "Provide {version, config} with the full house-rules shape " +
          "(equipmentIndividualCapPercent and equipmentCombinedCapPercent 0..100; " +
          "consumableGradeRates.F/E/D/C each 0..100000; " +
          "maxTranscendentSkills 0..8)"
      )
    }
    const { version, config } = parsed.data

    // The conditional CAS update and the response read run in ONE transaction so
    // an interleaved admin edit is never observed half-applied: the update and
    // the findUnique that produces the returned result commit together. A stale
    // version is a 409; a missing singleton row is a 503.
    return prisma.$transaction(async (tx) => {
      const result = await tx.houseRules.updateMany({
        where: { id: HOUSE_RULES_ID, version },
        data: {
          config: config as Prisma.InputJsonValue,
          version: { increment: 1 },
        },
      })
      if (result.count !== 1) {
        // Distinguish "missing row" (503) from "stale version" (409): both make
        // the conditional `updateMany` match 0 rows, so check existence here,
        // inside the same transaction.
        const existing = await tx.houseRules.findUnique({
          where: { id: HOUSE_RULES_ID },
        })
        if (!existing) {
          throw new ApiError(
            503,
            "ruleset_unavailable",
            "The server-wide house rules row is missing; apply migrations"
          )
        }
        throw conflict(
          "version_conflict",
          `House-rules version mismatch: expected ${version}, got a newer version`
        )
      }

      const updated = await tx.houseRules.findUnique({
        where: { id: HOUSE_RULES_ID },
      })
      const configOut = houseRulesConfigSchema.parse(updated!.config)
      return Response.json({
        version: updated!.version,
        config: configOut,
        updatedAt: updated!.updatedAt.toISOString(),
      })
    })
  })
}
