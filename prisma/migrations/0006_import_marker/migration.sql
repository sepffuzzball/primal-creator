-- Mark characters created from a user-supplied trusted-backup JSON import
-- (POST /api/characters/import). Never authoritative server-verified
-- progression; `imported` distinguishes untrusted imported history so the UI
-- can label the character as an unverified backup. Defaults false for
-- characters created through the normal flow.
ALTER TABLE "characters" ADD COLUMN "imported" BOOLEAN NOT NULL DEFAULT false;
