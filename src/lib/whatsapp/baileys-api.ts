// ============================================================
// Baileys Microservice API Client
//
// Communicates with the standalone `baileys-server` microservice
// (deployed on Render/VPS/Docker) for WhatsApp Web QR connection.
// ============================================================

export interface BaileysStatusResponse {
  status: 'disconnected' | 'connecting' | 'qr_ready' | 'connected';
  qrCode: string | null;
  phoneNumber: string | null;
}

export interface SendBaileysMessageParams {
  to: string;
  messageType?: string;
  contentText?: string | null;
  mediaUrl?: string | null;
}

export interface SendBaileysMessageResponse {
  success: boolean;
  whatsappMessageId: string;
}

const DEFAULT_SECRET = process.env.BAILEYS_SECRET_TOKEN || 'wacrm-baileys-secret-key';

function cleanUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/**
 * Start or reconnect a Baileys session on the microservice for a given accountId
 */
export async function startBaileysSession(
  serverUrl: string,
  accountId: string,
  webhookUrl: string,
  secretToken: string = DEFAULT_SECRET
): Promise<{ status: string; qr: string | null }> {
  const url = `${cleanUrl(serverUrl)}/api/sessions/start`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-baileys-secret': secretToken,
    },
    body: JSON.stringify({ accountId, webhookUrl }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to start Baileys session (${res.status}): ${errorText}`);
  }

  return res.json();
}

/**
 * Fetch current connection status & QR code from the microservice
 */
export async function getBaileysStatus(
  serverUrl: string,
  accountId: string,
  secretToken: string = DEFAULT_SECRET
): Promise<BaileysStatusResponse> {
  const url = `${cleanUrl(serverUrl)}/api/sessions/${accountId}/status`;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'x-baileys-secret': secretToken,
    },
    cache: 'no-store',
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to get Baileys status (${res.status}): ${errorText}`);
  }

  return res.json();
}

/**
 * Disconnect and logout Baileys session on the microservice
 */
export async function disconnectBaileysSession(
  serverUrl: string,
  accountId: string,
  secretToken: string = DEFAULT_SECRET
): Promise<{ success: boolean }> {
  const url = `${cleanUrl(serverUrl)}/api/sessions/${accountId}/disconnect`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'x-baileys-secret': secretToken,
    },
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to disconnect Baileys session (${res.status}): ${errorText}`);
  }

  return res.json();
}

/**
 * Send outbound message via Baileys microservice
 */
export async function sendBaileysMessage(
  serverUrl: string,
  accountId: string,
  params: SendBaileysMessageParams,
  secretToken: string = DEFAULT_SECRET
): Promise<SendBaileysMessageResponse> {
  const url = `${cleanUrl(serverUrl)}/api/messages/send`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-baileys-secret': secretToken,
    },
    body: JSON.stringify({
      accountId,
      ...params,
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to send Baileys message (${res.status}): ${errorText}`);
  }

  return res.json();
}
