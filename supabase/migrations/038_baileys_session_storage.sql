-- Migration 038: Baileys Session Storage for persistent multi-device auth keys
-- Allows baileys-server (e.g. on Render with ephemeral disk) to persist session
-- auth files to Supabase PostgreSQL, enabling automatic session restoration
-- across service restarts and deployments without re-scanning QR codes.

CREATE TABLE IF NOT EXISTS baileys_session_files (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  file_data TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT baileys_session_files_account_file_key UNIQUE (account_id, file_name)
);

CREATE INDEX IF NOT EXISTS idx_baileys_session_files_account ON baileys_session_files(account_id);

ALTER TABLE baileys_session_files ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS baileys_session_files_policy ON baileys_session_files;
CREATE POLICY baileys_session_files_policy ON baileys_session_files FOR ALL USING (true);
