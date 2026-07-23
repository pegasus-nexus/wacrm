import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';
import { findExistingContact } from '@/lib/contacts/dedupe';
import { runAutomationsForTrigger } from '@/lib/automations/engine';
import { dispatchInboundToFlows } from '@/lib/flows/engine';
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply';
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver';

export const maxDuration = 60;

const SECRET_TOKEN = process.env.BAILEYS_SECRET_TOKEN || 'wacrm-baileys-secret-key';

let _adminClient: any = null;
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  }
  return _adminClient;
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-baileys-secret',
    },
  });
}

export async function POST(request: Request) {
  try {
    const secret = request.headers.get('x-baileys-secret');
    if (secret !== SECRET_TOKEN) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { accountId, event, status, qrCode, phoneNumber, message } = body;

    if (!accountId) {
      return NextResponse.json({ error: 'Missing accountId' }, { status: 400 });
    }

    const db = supabaseAdmin();

    // 0. Session Auth Sync via Webhook (Proxy for Render ephemeral container disks)
    if (event === 'session.sync' && Array.isArray(body.files)) {
      for (const f of body.files) {
        if (f.fileName && f.fileData) {
          await db.from('baileys_session_files').upsert(
            {
              account_id: accountId,
              file_name: f.fileName,
              file_data: f.fileData,
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'account_id,file_name' }
          );
        }
      }
      return NextResponse.json({ success: true });
    }

    if (event === 'session.hydrate') {
      const { data: dbFiles } = await db
        .from('baileys_session_files')
        .select('file_name, file_data')
        .eq('account_id', accountId);

      const files = (dbFiles || []).map((row: any) => ({
        fileName: row.file_name,
        fileData: row.file_data,
      }));

      return NextResponse.json({ success: true, files });
    }

    if (event === 'session.delete') {
      await db.from('baileys_session_files').delete().eq('account_id', accountId);
      return NextResponse.json({ success: true });
    }

    // 1. Connection Update event (QR code, connected, disconnected)
    if (event === 'connection.update') {
      const updatePayload: Record<string, any> = {
        baileys_status: status,
        updated_at: new Date().toISOString(),
      };

      if (status === 'qr_ready') {
        updatePayload.baileys_qr_code = qrCode || null;
      } else if (status === 'connected') {
        updatePayload.baileys_qr_code = null;
        updatePayload.baileys_status = 'connected';
        updatePayload.status = 'connected';
        updatePayload.connected_at = new Date().toISOString();
        if (phoneNumber) {
          updatePayload.baileys_phone_number = phoneNumber;
        }
      } else if (status === 'disconnected') {
        updatePayload.baileys_qr_code = null;
        updatePayload.baileys_status = 'disconnected';
        updatePayload.status = 'disconnected';
      }

      await db
        .from('whatsapp_config')
        .update(updatePayload)
        .eq('account_id', accountId);

      return NextResponse.json({ success: true });
    }

    // 2. Reaction event
    if (event === 'messages.reaction' && body.reaction) {
      const { messageId, emoji } = body.reaction;
      const { data: targetMsg } = await db
        .from('messages')
        .select('id, conversation_id, conversations(account_id, contact_id)')
        .eq('message_id', messageId)
        .maybeSingle();

      if (targetMsg) {
        const conv = targetMsg.conversations as any;
        if (conv?.account_id === accountId) {
          const contactId = conv.contact_id;
          if (!emoji) {
            await db
              .from('message_reactions')
              .delete()
              .eq('message_id', targetMsg.id)
              .eq('actor_type', 'customer')
              .eq('actor_id', contactId);
          } else {
            await db.from('message_reactions').upsert(
              {
                message_id: targetMsg.id,
                conversation_id: targetMsg.conversation_id,
                actor_type: 'customer',
                actor_id: contactId,
                emoji,
              },
              { onConflict: 'message_id,actor_type,actor_id' }
            );
          }
        }
      }
      return NextResponse.json({ success: true });
    }

    // 3. Message Upsert event (Inbound & Outbound sync)
    if (event === 'messages.upsert' && message) {
      const fromPhone = message.from;
      const isFromMe = Boolean(message.fromMe);

      const normalizedPhone = normalizePhone(fromPhone);
      if (!normalizedPhone) {
        return NextResponse.json({ success: true, warning: 'Invalid phone format' });
      }

      // Resolve valid auth.users(id) for FK constraint
      let configOwnerUserId: string | null = null;
      const { data: config } = await db
        .from('whatsapp_config')
        .select('user_id')
        .eq('account_id', accountId)
        .maybeSingle();

      if (config?.user_id) {
        configOwnerUserId = config.user_id;
      } else {
        const { data: profile } = await db
          .from('profiles')
          .select('user_id')
          .eq('account_id', accountId)
          .limit(1)
          .maybeSingle();
        if (profile?.user_id) {
          configOwnerUserId = profile.user_id;
        }
      }

      if (!configOwnerUserId) {
        console.error('[baileys-webhook] No configOwnerUserId found for account:', accountId);
        return NextResponse.json({ error: 'Account owner user_id not found' }, { status: 400 });
      }

      // Extract real WhatsApp display name if available
      const pushName = message.pushName || body.pushName;
      const displayName = pushName && pushName.trim() ? pushName.trim() : null;

      // Find or create contact
      let contact = await findExistingContact(db, accountId, normalizedPhone);
      if (!contact) {
        const { data: newContact, error: createError } = await db
          .from('contacts')
          .insert({
            account_id: accountId,
            user_id: configOwnerUserId,
            phone: normalizedPhone,
            name: displayName || normalizedPhone,
          })
          .select('*')
          .single();

        if (createError || !newContact) {
          console.error('[baileys-webhook] Failed creating contact:', createError);
          return NextResponse.json({ error: 'Contact creation failed' }, { status: 500 });
        }
        contact = newContact;
      } else if (displayName && (contact.name === contact.phone || /^\+?\d+$/.test(contact.name || ''))) {
        // Update contact with actual WhatsApp display name if it currently has a raw phone string as name
        await db
          .from('contacts')
          .update({ name: displayName })
          .eq('id', contact.id);
        contact.name = displayName;
      }

      if (!contact) {
        return NextResponse.json({ error: 'Contact unresolved' }, { status: 500 });
      }

      // Find or create conversation
      let { data: conversation } = await db
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contact.id)
        .maybeSingle();

      if (!conversation) {
        const { data: newConv, error: convError } = await db
          .from('conversations')
          .insert({
            account_id: accountId,
            user_id: configOwnerUserId,
            contact_id: contact.id,
            unread_count: isFromMe ? 0 : 1,
            last_message_text: message.text?.body || `[${message.type}]`,
            last_message_at: new Date().toISOString(),
          })
          .select('*')
          .single();

        if (convError || !newConv) {
          console.error('[baileys-webhook] Conversation insert error:', convError);
          return NextResponse.json({ error: 'Conversation creation failed' }, { status: 500 });
        }
        conversation = newConv;
      } else {
        const updateData: Record<string, any> = {
          last_message_text: message.text?.body || `[${message.type}]`,
          last_message_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        if (!isFromMe) {
          updateData.unread_count = (conversation.unread_count || 0) + 1;
        }

        await db
          .from('conversations')
          .update(updateData)
          .eq('id', conversation.id);
      }

      // Insert message
      const ALLOWED_TYPES = new Set(['text', 'image', 'document', 'audio', 'video', 'location', 'template', 'interactive']);
      const contentType = ALLOWED_TYPES.has(message.type) ? message.type : 'text';

      const { data: insertedMsg, error: msgError } = await db
        .from('messages')
        .insert({
          conversation_id: conversation.id,
          sender_type: isFromMe ? 'agent' : 'customer',
          sender_id: isFromMe ? configOwnerUserId : undefined,
          content_type: contentType,
          content_text: message.text?.body || null,
          media_url: message.mediaUrl || null,
          message_id: message.id,
          status: isFromMe ? 'sent' : 'delivered',
        })
        .select('*')
        .single();

      if (msgError) {
        console.error('[baileys-webhook] Message insert error:', msgError);
        return NextResponse.json({ error: 'Message insert failed' }, { status: 500 });
      }

      // Trigger Automations, Flows, AI, and Webhooks ONLY for inbound messages from customer
      if (!isFromMe) {
        void runAutomationsForTrigger({
          accountId,
          triggerType: 'new_message_received',
          contactId: contact.id,
          context: {
            message_text: message.text?.body || '',
            conversation_id: conversation.id,
          },
        });

        void dispatchInboundToFlows({
          accountId,
          userId: configOwnerUserId,
          contactId: contact.id,
          conversationId: conversation.id,
          message: {
            kind: 'text',
            text: message.text?.body || '',
            meta_message_id: message.id,
          },
          isFirstInboundMessage: false,
        });

        void dispatchInboundToAiReply({
          accountId,
          conversationId: conversation.id,
          contactId: contact.id,
          configOwnerUserId,
        });

        void dispatchWebhookEvent(db, accountId, 'message.received', {
          conversation_id: conversation.id,
          contact_id: contact.id,
          whatsapp_message_id: message.id,
          content_type: contentType,
          text: message.text?.body || null,
        });
      }

      return NextResponse.json({ success: true, messageId: insertedMsg.id });
    }

    return NextResponse.json({ success: true, ignored: true });
  } catch (error: any) {
    console.error('[baileys-webhook] Unexpected error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
