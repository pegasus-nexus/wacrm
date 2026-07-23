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
        updatePayload.status = 'connected';
        updatePayload.connected_at = new Date().toISOString();
        if (phoneNumber) {
          updatePayload.baileys_phone_number = phoneNumber;
        }
      } else if (status === 'disconnected') {
        updatePayload.baileys_qr_code = null;
        updatePayload.status = 'disconnected';
      }

      await db
        .from('whatsapp_config')
        .update(updatePayload)
        .eq('account_id', accountId);

      return NextResponse.json({ success: true });
    }

    // 2. Message Upsert event (Inbound message)
    if (event === 'messages.upsert' && message) {
      const fromPhone = message.from;
      const normalizedPhone = normalizePhone(fromPhone);
      if (!normalizedPhone) {
        return NextResponse.json({ success: true, warning: 'Invalid phone format' });
      }

      // Find or create contact
      let contact = await findExistingContact(db, accountId, normalizedPhone);
      if (!contact) {
        const { data: newContact, error: createError } = await db
          .from('contacts')
          .insert({
            account_id: accountId,
            user_id: accountId,
            phone: normalizedPhone,
            name: fromPhone,
          })
          .select('*')
          .single();

        if (createError || !newContact) {
          console.error('[baileys-webhook] Failed creating contact:', createError);
          return NextResponse.json({ error: 'Contact creation failed' }, { status: 500 });
        }
        contact = newContact;
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
            user_id: accountId,
            contact_id: contact.id,
            unread_count: 1,
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
        await db
          .from('conversations')
          .update({
            unread_count: (conversation.unread_count || 0) + 1,
            last_message_text: message.text?.body || `[${message.type}]`,
            last_message_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', conversation.id);
      }

      // Insert message
      const { data: insertedMsg, error: msgError } = await db
        .from('messages')
        .insert({
          conversation_id: conversation.id,
          sender_type: 'customer',
          content_type: message.type || 'text',
          content_text: message.text?.body || null,
          message_id: message.id,
          status: 'delivered',
        })
        .select('*')
        .single();

      if (msgError) {
        console.error('[baileys-webhook] Message insert error:', msgError);
        return NextResponse.json({ error: 'Message insert failed' }, { status: 500 });
      }

      // Trigger Automations, Flows, AI, and Webhooks asynchronously
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
        userId: accountId,
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
        configOwnerUserId: accountId,
      });

      void dispatchWebhookEvent(db, accountId, 'message.received', {
        conversation_id: conversation.id,
        contact_id: contact.id,
        whatsapp_message_id: message.id,
        content_type: message.type || 'text',
        text: message.text?.body || null,
      });

      return NextResponse.json({ success: true, messageId: insertedMsg.id });
    }

    return NextResponse.json({ success: true, ignored: true });
  } catch (error: any) {
    console.error('[baileys-webhook] Unexpected error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
