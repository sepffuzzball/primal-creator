-- Admin-managed regular users and self-service password changes with immediate
-- session revocation.
--
-- `disabled` marks a user as unable to sign in (and revokes any existing
-- session because token verification rejects disabled users on every request).
-- `sessionVersion` is a session-revocation counter: any role, disable or
-- password change increments it, and a JWT carrying an older version is rejected,
-- so a reset invalidates all previously issued tokens immediately.

-- Add disabled flag, default false.
ALTER TABLE "users" ADD COLUMN "disabled" BOOLEAN NOT NULL DEFAULT false;

-- Add sessionVersion counter, default 0.
ALTER TABLE "users" ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0;
