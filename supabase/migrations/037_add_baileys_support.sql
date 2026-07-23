-- ============================================================
-- 037_add_baileys_support
--
-- Adds fields to whatsapp_config to support Baileys as an alternative
-- connection provider alongside Meta Cloud API.
-- ============================================================

-- 1. Make Meta-specific fields nullable so Baileys-only setups can exist
ALTER TABLE whatsapp_config ALTER COLUMN phone_number_id DROP NOT NULL;
ALTER TABLE whatsapp_config ALTER COLUMN access_token DROP NOT NULL;

-- 2. Add connection type and Baileys specific fields
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS connection_type TEXT NOT NULL DEFAULT 'meta' CHECK (connection_type IN ('meta', 'baileys')),
  ADD COLUMN IF NOT EXISTS baileys_server_url TEXT,
  ADD COLUMN IF NOT EXISTS baileys_status TEXT DEFAULT 'disconnected' CHECK (baileys_status IN ('disconnected', 'connecting', 'qr_ready', 'connected')),
  ADD COLUMN IF NOT EXISTS baileys_qr_code TEXT,
  ADD COLUMN IF NOT EXISTS baileys_phone_number TEXT,
  ADD COLUMN IF NOT EXISTS baileys_secret_token TEXT,
  ADD COLUMN IF NOT EXISTS baileys_broadcast_delay_sec INT DEFAULT 5 CHECK (baileys_broadcast_delay_sec >= 1 AND baileys_broadcast_delay_sec <= 60);

-- Index for fast lookup by baileys_phone_number when routing webhooks
CREATE INDEX IF NOT EXISTS idx_whatsapp_config_baileys_phone ON whatsapp_config(baileys_phone_number);
