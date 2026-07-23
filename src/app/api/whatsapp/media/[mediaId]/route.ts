import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'

const BAILEYS_SECRET = process.env.BAILEYS_SECRET_TOKEN || 'wacrm-baileys-secret-key'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ mediaId: string }> }
) {
  try {
    const { mediaId } = await params

    if (!mediaId) {
      return NextResponse.json(
        { error: 'Media ID is required' },
        { status: 400 }
      )
    }

    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    // Resolve the caller's account_id — whatsapp_config is one-per-
    // account post-multi-user, so a teammate fetching media for a
    // conversation in the shared inbox needs the account's config,
    // not their personal (non-existent) row.
    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    // Fetch WhatsApp config
    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .single()

    if (configError || !config) {
      return NextResponse.json(
        { error: 'WhatsApp not configured' },
        { status: 400 }
      )
    }

    // Baileys: proxy to the baileys-server media endpoint
    if (config.connection_type === 'baileys') {
      if (!config.baileys_server_url) {
        return NextResponse.json(
          { error: 'Baileys server URL not configured' },
          { status: 400 }
        )
      }

      const baileysUrl = config.baileys_server_url.replace(/\/+$/, '')
      const mediaResponse = await fetch(`${baileysUrl}/api/media/${encodeURIComponent(mediaId)}`, {
        headers: {
          'x-baileys-secret': config.baileys_secret_token || BAILEYS_SECRET,
        },
      })

      if (!mediaResponse.ok) {
        const errText = await mediaResponse.text()
        console.error('[media proxy] Baileys media fetch failed:', mediaResponse.status, errText)
        return NextResponse.json(
          { error: 'Failed to fetch media from Baileys' },
          { status: mediaResponse.status }
        )
      }

      const contentType = mediaResponse.headers.get('content-type') || 'application/octet-stream'
      const buffer = Buffer.from(await mediaResponse.arrayBuffer())

      return new Response(new Uint8Array(buffer), {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=86400',
        },
      })
    }

    // Meta: original flow
    const accessToken = decrypt(config.access_token)

    // Get the download URL from Meta
    const mediaInfo = await getMediaUrl({ mediaId, accessToken })

    // Download the binary data
    const { buffer, contentType } = await downloadMedia({
      downloadUrl: mediaInfo.url,
      accessToken,
    })

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': contentType || mediaInfo.mimeType || 'application/octet-stream',
        'Cache-Control': 'public, max-age=86400',
      },
    })
  } catch (error) {
    console.error('Error in WhatsApp media GET:', error)
    return NextResponse.json(
      { error: 'Failed to fetch media' },
      { status: 500 }
    )
  }
}
