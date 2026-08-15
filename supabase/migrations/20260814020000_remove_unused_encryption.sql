-- Migration: Remove unused AES/pgcrypto encryption scaffolding
--
-- encrypt_sensitive_data/decrypt_sensitive_data (added in
-- 20260810000000_security_encryption_pgcrypto.sql) and the corresponding
-- score_audit_log.encrypted_note column were never called by any app code
-- (confirmed by repo-wide search — no references outside that migration).
-- The functions also fell back to a hardcoded default passphrase since
-- nothing ever set the `app.settings.encryption_key` Postgres setting they
-- read from, so they provided no real protection even if something had
-- called them. Removing rather than leaving unused attack surface around.
--
-- pgcrypto extension itself is left enabled (harmless, may be useful later).

DROP FUNCTION IF EXISTS public.encrypt_sensitive_data(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.decrypt_sensitive_data(TEXT, TEXT);

ALTER TABLE public.score_audit_log
DROP COLUMN IF EXISTS encrypted_note;
