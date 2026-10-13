/**
 * Zod schema for the JSON surface of the character-creation draft API.
 *
 * A draft is a resumable character-creation snapshot that is persisted per
 * authenticated user but is NEVER authoritative final character state. The only
 * fields the server accepts and stores are the ones whitelisted below; anything
 * else (stat vectors, awards, effects, uploaded binaries) is rejected or dropped.
 *
 * The payload is bounded: each string field has a per-field cap and the whole
 * `data` object is capped at 20KB, so a draft never grows unbounded and no
 * binary is ever accepted (only JSON-serializable values).
 */

import { z } from "zod"
import { specialAbilitiesSchema } from "@/lib/server/schemas"

/** Hard cap on the serialized `data` payload (20 KB). */
export const DRAFT_DATA_MAX_BYTES = 20 * 1024

const boundedString = (max: number, opts?: { nullable?: boolean }) => {
  const s = z.string().max(max)
  return opts?.nullable ? s.nullable().optional() : s.optional()
}

/**
 * The whitelisted draft payload. This is intentionally a strict object: any key
 * not listed here is rejected with a 400 so a client can never sneak a
 * stat/award/effect field (or a misunderstood shape) into the draft. Every field
 * is optional because a draft is resumable at any step, and a step list is
 * deliberately not enforced here (the client owns step progression).
 *
 * `equipment` is a list of selected catalog stableIds/ids, `special` is the
 * "has special abilities" flag, and `specialAbilities` is the explicit
 * blessing/bloodline/transcendent selection (validated to the same bounds as the
 * final create) that a legacy `special: true` draft does NOT imply - the server
 * never grants a power from the boolean alone. `origin`/`raceId`/`classId`/
 * `professionId` mirror the final Character creation fields. The textual fields
 * map to the nullable `description`, `nickname`, `pronouns`, `ageDescription`,
 * `appearance`, `biography` and `notes` columns of the final creation step.
 */
export const draftDataSchema = z
  .object({
    step: z.number().int().nonnegative().optional(),
    name: boundedString(256),
    description: boundedString(8000, { nullable: true }),
    origin: z.enum(["integrated", "born"]).optional(),
    raceId: z.string().max(128).optional(),
    classId: z.string().max(128).optional(),
    professionId: z.string().max(128).nullable().optional(),
    special: z.boolean().optional(),
    specialAbilities: specialAbilitiesSchema.optional(),
    equipment: z.array(z.string().max(128)).max(128).optional(),
    nickname: boundedString(200, { nullable: true }),
    pronouns: boundedString(100, { nullable: true }),
    ageDescription: boundedString(4000, { nullable: true }),
    appearance: boundedString(8000, { nullable: true }),
    biography: boundedString(8000, { nullable: true }),
    notes: boundedString(4000, { nullable: true }),
  })
  .strict()
  .refine(
    (data) => {
      const bytes = Buffer.byteLength(JSON.stringify(data), "utf8")
      return bytes <= DRAFT_DATA_MAX_BYTES
    },
    `Draft data exceeds the ${DRAFT_DATA_MAX_BYTES / 1024}KB limit`
  )

/** The validated draft data payload type (inferred from the schema). */
export type DraftData = z.infer<typeof draftDataSchema>

/**
 * Request body for PUT /api/drafts. `data` is the whitelisted payload and
 * `version` is the optimistic-concurrency token. When `version` is omitted the
 * server only creates the draft (if none exists); if a draft already exists and
 * `version` is omitted it is a 409 `version_required` (the server never guesses
 * the latest version). When `version` is supplied it must exactly match the
 * stored version, else 409.
 */
export const draftPutSchema = z.object({
  data: draftDataSchema,
  version: z.number().int().nonnegative().optional(),
})

/**
 * The public draft view returned by the API. `data` is the stored (validated,
 * whitelisted) JSON; `updatedAt` is an ISO timestamp. The server never returns
 * `userId` here - the draft is implicitly scoped to the authenticated caller.
 */
export interface DraftView {
  id: string
  data: unknown
  version: number
  updatedAt: string
}
