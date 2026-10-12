/**
 * Character-creation draft persistence.
 *
 * A draft is a resumable character-creation snapshot scoped to one authenticated
 * user (at most one per user). It is NOT authoritative character state - the
 * final Character row (and its engine CharacterState) is created by the existing
 * createCharacter flow, which is a separate operation and stays transactional in
 * its own right. This module only stores and CAS-versions trusted draft `data`;
 * it never derives stats, awards or effects itself.
 *
 * Optimistic concurrency mirrors the character service: every mutation of an
 * existing draft must present the exact current `version`; a mismatch (or a
 * concurrent create racing on the unique per-user constraint) is a 409 conflict.
 * A draft that is absent is created only when `version` is omitted; a PUT with a
 * `version` and no draft is a conflict because there is nothing to update. When
 * a draft already exists, `version` is required: a PUT or DELETE that omits it
 * returns a 409 `version_required` rather than silently capturing the latest
 * version.
 */

import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/db/client"
import { conflict } from "@/lib/server/errors"
import type { SessionUser } from "@/lib/auth/session"
import type { DraftData, DraftView } from "@/lib/server/draft-schema"

// ------------------------------------------------------------------ //
// Helpers
// ------------------------------------------------------------------ //

/** Detect a Prisma unique-constraint violation (P2002), e.g. a create race. */
function isUniqueViolation(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    (err as { code?: string }).code === "P2002"
  )
}

function toView(row: {
  id: string
  data: unknown
  version: number
  updatedAt: Date
}): DraftView {
  return {
    id: row.id,
    data: row.data,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  }
}

// ------------------------------------------------------------------ //
// Reads
// ------------------------------------------------------------------ //

/** Return the authenticated user's draft, or null when none exists. */
export async function getDraft(user: SessionUser): Promise<DraftView | null> {
  const row = await prisma.characterDraft.findUnique({
    where: { userId: user.id },
  })
  return row ? toView(row) : null
}

// ------------------------------------------------------------------ //
// Writes
// ------------------------------------------------------------------ //

/**
 * Create or update the authenticated user's draft.
 *
 * Semantics:
 *   - No draft and `version` omitted -> create (version 0). A concurrent create
 *     that wins the unique per-user race makes this CREATE hit P2002, which is
 *     mapped to a 409 conflict (the losing create never silently overwrites).
 *   - No draft but `version` supplied -> 409 (nothing to update).
 *   - Draft present -> CAS update at the exact supplied `version`; omitting
 *     `version` is a 409 `version_required` (the server never guesses the latest
 *     version). A stale `version` matches 0 rows and 409s.
 */
export async function saveDraft(
  user: SessionUser,
  input: { data: DraftData; version?: number }
): Promise<DraftView> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.characterDraft.findUnique({
      where: { userId: user.id },
    })

    if (!existing) {
      if (input.version == null) {
        try {
          const created = await tx.characterDraft.create({
            data: {
              userId: user.id,
              data: input.data as Prisma.InputJsonValue,
              version: 0,
            },
          })
          return toView(created)
        } catch (err) {
          // A concurrent create won the unique user constraint; treat the losing
          // create as a conflict rather than silently overwriting.
          if (isUniqueViolation(err)) {
            throw conflict(
              "draft_conflict",
              "A draft already exists; retry with its version to update"
            )
          }
          throw err
        }
      }
      throw conflict(
        "draft_conflict",
        "No draft exists to update for this user"
      )
    }

    if (input.version == null) {
      throw conflict(
        "version_required",
        "A draft already exists; provide its current version to update it"
      )
    }

    const result = await tx.characterDraft.updateMany({
      where: { userId: user.id, version: input.version },
      data: {
        data: input.data as Prisma.InputJsonValue,
        version: { increment: 1 },
      },
    })
    if (result.count !== 1) {
      throw conflict(
        "draft_conflict",
        `Draft version mismatch: expected ${input.version}`
      )
    }
    const updated = await tx.characterDraft.findUniqueOrThrow({
      where: { userId: user.id },
    })
    return toView(updated)
  })
}

/**
 * Delete the authenticated user's draft (owner-only; a draft is always scoped to
 * the caller's userId).
 *
 * Semantics:
 *   - No draft and `version` omitted -> idempotent no-op ({ deleted: false }).
 *   - No draft but `version` supplied -> 409 (nothing to delete at that version).
 *   - Draft present -> CAS delete at the exact supplied `version`; omitting
 *     `version` is a 409 `version_required`. A stale `version` deletes 0 rows and
 *     409s.
 */
export async function deleteDraft(
  user: SessionUser,
  input: { version?: number } = {}
): Promise<{ deleted: boolean }> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.characterDraft.findUnique({
      where: { userId: user.id },
    })
    if (!existing) {
      if (input.version != null) {
        throw conflict(
          "draft_conflict",
          "No draft exists to delete for this user"
        )
      }
      return { deleted: false }
    }

    if (input.version == null) {
      throw conflict(
        "version_required",
        "A draft exists; provide its current version to delete it"
      )
    }

    const result = await tx.characterDraft.deleteMany({
      where: { userId: user.id, version: input.version },
    })
    if (result.count !== 1) {
      throw conflict(
        "draft_conflict",
        `Draft version mismatch: expected ${input.version}`
      )
    }
    return { deleted: true }
  })
}
