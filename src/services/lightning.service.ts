import { BIG_RELAY_URLS, CODY_PUBKEY, JUMBLE_PUBKEY } from '@/constants'
import { getZapInfoFromEvent } from '@/lib/event-metadata'
import { TProfile } from '@/types'
import { init, launchPaymentModal } from '@getalby/bitcoin-connect-react'
import { Invoice } from '@getalby/lightning-tools'
import { bech32 } from '@scure/base'
import { WebLNProvider } from '@webbtc/webln-types'
import dayjs from 'dayjs'
import { Filter, kinds, NostrEvent } from 'nostr-tools'
import { SubCloser } from 'nostr-tools/abstract-pool'
import { makeZapRequest } from 'nostr-tools/nip57'
import { utf8Decoder } from 'nostr-tools/utils'
import client from './client.service'

export type TRecentSupporter = { pubkey: string; amount: number; comment?: string }

const OFFICIAL_PUBKEYS = [JUMBLE_PUBKEY, CODY_PUBKEY]

class LightningService {
  static instance: LightningService
  provider: WebLNProvider | null = null
  private recentSupportersCache: TRecentSupporter[] | null = null

  constructor() {
    if (!LightningService.instance) {
      LightningService.instance = this
      init({
        appName: 'Jumble',
        showBalance: false
      })
    }
    return LightningService.instance
  }

  async zap(
    sender: string,
    recipientOrEvent: string | NostrEvent,
    sats: number,
    comment: string,
    closeOuterModel?: () => void
  ): Promise<{ preimage: string; invoice: string } | null> {
    if (!client.signer) {
      throw new Error('You need to be logged in to zap')
    }
    const { recipient, event } =
      typeof recipientOrEvent === 'string'
        ? { recipient: recipientOrEvent }
        : { recipient: recipientOrEvent.pubkey, event: recipientOrEvent }

    const [profile, receiptRelayList, senderRelayList] = await Promise.all([
      client.fetchProfile(recipient, true),
      client.fetchRelayList(recipient),
      sender
        ? client.fetchRelayList(sender)
        : Promise.resolve({ read: BIG_RELAY_URLS, write: BIG_RELAY_URLS })
    ])
    if (!profile) {
      throw new Error('Recipient not found')
    }
    const zapEndpoint = await this.getZapEndpoint(profile)
    if (!zapEndpoint) {
      throw new Error("Recipient's lightning address is invalid")
    }
    const { callback, lnurl } = zapEndpoint
    const amount = sats * 1000
    const zapRequestDraft = makeZapRequest({
      ...(event ? { event } : { pubkey: recipient }),
      amount,
      relays: receiptRelayList.read
        .slice(0, 4)
        .concat(senderRelayList.write.slice(0, 3))
        .concat(BIG_RELAY_URLS),
      comment
    })
    const zapRequest = await client.signer.signEvent(zapRequestDraft)
    const zapRequestRes = await fetch(
      `${callback}?amount=${amount}&nostr=${encodeURI(JSON.stringify(zapRequest))}&lnurl=${lnurl}`
    )
    const zapRequestResBody = await zapRequestRes.json()
    if (zapRequestResBody.error) {
      throw new Error(zapRequestResBody.message)
    }
    const { pr, verify, reason } = zapRequestResBody
    if (!pr) {
      throw new Error(reason ?? 'Failed to create invoice')
    }

    if (this.provider) {
      const { preimage } = await this.provider.sendPayment(pr)
      closeOuterModel?.()
      return { preimage, invoice: pr }
    }

    return new Promise((resolve) => {
      closeOuterModel?.()
      let checkPaymentInterval: ReturnType<typeof setInterval> | undefined
      let subCloser: SubCloser | undefined
      const { setPaid } = launchPaymentModal({
        invoice: pr,
        onPaid: (response) => {
          clearInterval(checkPaymentInterval)
          subCloser?.close()
          resolve({ preimage: response.preimage, invoice: pr })
        },
        onCancelled: () => {
          clearInterval(checkPaymentInterval)
          subCloser?.close()
          resolve(null)
        }
      })

      if (verify) {
        checkPaymentInterval = setInterval(async () => {
          const invoice = new Invoice({ pr, verify })
          const paid = await invoice.verifyPayment()

          if (paid && invoice.preimage) {
            setPaid({
              preimage: invoice.preimage
            })
          }
        }, 1000)
      } else {
        const filter: Filter = {
          kinds: [kinds.Zap],
          '#p': [recipient],
          since: dayjs().subtract(1, 'minute').unix()
        }
        if (event) {
          filter['#e'] = [event.id]
        }
        subCloser = client.subscribe(
          senderRelayList.write.concat(BIG_RELAY_URLS).slice(0, 4),
          filter,
          {
            onevent: (evt) => {
              const info = getZapInfoFromEvent(evt)
              if (!info) return

              if (info.invoice === pr) {
                setPaid({ preimage: info.preimage ?? '' })
              }
            }
          }
        )
      }
    })
  }

  async payInvoice(
    invoice: string,
    closeOuterModel?: () => void
  ): Promise<{ preimage: string; invoice: string } | null> {
    if (this.provider) {
      const { preimage } = await this.provider.sendPayment(invoice)
      closeOuterModel?.()
      return { preimage, invoice: invoice }
    }

    return new Promise((resolve) => {
      closeOuterModel?.()
      launchPaymentModal({
        invoice: invoice,
        onPaid: (response) => {
          resolve({ preimage: response.preimage, invoice: invoice })
        },
        onCancelled: () => {
          resolve(null)
        }
      })
    })
  }

  async arkadeZap(
    sender: string,
    recipientOrEvent: string | NostrEvent,
    sats: number,
    comment: string,
    closeOuterModel?: () => void
  ): Promise<{ vtxoTxid: string; arkadeAddress: string } | null> {
    if (!client.signer) {
      throw new Error('You need to be logged in to zap')
    }
    if (!this.provider) {
      throw new Error('NWC provider required for Arkade zaps. Please connect your Arkade wallet.')
    }

    const { recipient, event } =
      typeof recipientOrEvent === 'string'
        ? { recipient: recipientOrEvent }
        : { recipient: recipientOrEvent.pubkey, event: recipientOrEvent }

    const [profile, receiptRelayList, senderRelayList] = await Promise.all([
      client.fetchProfile(recipient, true),
      client.fetchRelayList(recipient),
      sender
        ? client.fetchRelayList(sender)
        : Promise.resolve({ read: BIG_RELAY_URLS, write: BIG_RELAY_URLS })
    ])

    if (!profile) {
      throw new Error('Recipient not found')
    }

    if (!profile.arkade) {
      throw new Error("Recipient doesn't have an Arkade address")
    }

    const arkadeAddress = profile.arkade
    const amount = sats * 1000 // Convert to millisats

    // Create zap request (kind 9734)
    // Note: The zap request will be sent by the Arkade wallet NWC server to the relays
    // after payment is confirmed
    const zapRequestDraft = makeZapRequest({
      ...(event ? { event } : { pubkey: recipient }),
      amount,
      relays: receiptRelayList.read
        .slice(0, 4)
        .concat(senderRelayList.write.slice(0, 3))
        .concat(BIG_RELAY_URLS),
      comment
    })
    // We sign the zap request but it will be included in the description tag of the receipt
    await client.signer.signEvent(zapRequestDraft)

    // Send Arkade payment via NWC
    // The NWC server expects "invoice" parameter but will accept Arkade address (ark1...)
    // For Arkade addresses, we must pass the amount since it's not encoded in the address
    try {
      console.log('Sending Arkade payment:', { arkadeAddress, amount })
      console.log('Provider object:', this.provider)
      console.log('Provider.client:', (this.provider as any).client)

      // Access the internal NWC client
      const nwcClient = (this.provider as any).client

      if (!nwcClient) {
        throw new Error('No NWC client found in provider')
      }

      // Use executeNip47Request to send a raw NIP-47 pay_invoice request with amount parameter
      // This is the low-level method that allows us to pass the amount parameter
      // which is required for Arkade addresses (since they don't encode the amount like BOLT11)
      console.log('Calling executeNip47Request with pay_invoice method')
      console.log('Parameters:', { invoice: arkadeAddress, amount })

      const response = await nwcClient.executeNip47Request('pay_invoice', {
        invoice: arkadeAddress,
        amount
      })

      console.log('Arkade payment response:', response)
      closeOuterModel?.()

      // For Arkade, the response should contain the vtxo txid
      // The wallet should return it in the preimage field or a custom field
      const vtxoTxid = (response as any).vtxoTxid || response.preimage

      if (!vtxoTxid) {
        console.warn('No vtxoTxid in response, zap may have succeeded but tracking may fail')
      }

      // Listen for zap receipt
      this.listenForArkadeZapReceipt(recipient, event?.id, senderRelayList)

      return { vtxoTxid, arkadeAddress }
    } catch (error) {
      console.error('Arkade zap error:', error)
      throw new Error(
        `Arkade zap failed: ${error instanceof Error ? error.message : 'Unknown error'}. ` +
        `Make sure your NWC wallet supports pay_invoice with amount parameter.`
      )
    }
  }

  private listenForArkadeZapReceipt(
    recipient: string,
    eventId: string | undefined,
    senderRelayList: { read: string[]; write: string[] }
  ) {
    const filter: Filter = {
      kinds: [kinds.Zap],
      '#p': [recipient],
      since: dayjs().subtract(1, 'minute').unix()
    }
    if (eventId) {
      filter['#e'] = [eventId]
    }

    const subCloser = client.subscribe(
      senderRelayList.write.concat(BIG_RELAY_URLS).slice(0, 4),
      filter,
      {
        onevent: (evt) => {
          const info = getZapInfoFromEvent(evt)
          if (!info) return

          // Check if this is our Arkade zap receipt
          if (info.isArkade && info.arkadeVtxoTxid) {
            console.log('Arkade zap receipt received:', info.arkadeVtxoTxid)
            subCloser.close()
          }
        }
      }
    )

    // Auto-close subscription after 2 minutes
    setTimeout(() => {
      subCloser.close()
    }, 120000)
  }

  async fetchRecentSupporters() {
    if (this.recentSupportersCache) {
      return this.recentSupportersCache
    }
    const relayList = await client.fetchRelayList(CODY_PUBKEY)
    const events = await client.fetchEvents(relayList.read.slice(0, 4), {
      authors: ['79f00d3f5a19ec806189fcab03c1be4ff81d18ee4f653c88fac41fe03570f432'], // alby
      kinds: [kinds.Zap],
      '#p': OFFICIAL_PUBKEYS,
      since: dayjs().subtract(1, 'month').unix()
    })
    events.sort((a, b) => b.created_at - a.created_at)
    const map = new Map<string, { pubkey: string; amount: number; comment?: string }>()
    events.forEach((event) => {
      const info = getZapInfoFromEvent(event)
      if (!info || !info.senderPubkey || OFFICIAL_PUBKEYS.includes(info.senderPubkey)) return

      const { amount, comment, senderPubkey } = info
      const item = map.get(senderPubkey)
      if (!item) {
        map.set(senderPubkey, { pubkey: senderPubkey, amount, comment })
      } else {
        item.amount += amount
        if (!item.comment && comment) item.comment = comment
      }
    })
    this.recentSupportersCache = Array.from(map.values())
      .filter((item) => item.amount >= 1000)
      .sort((a, b) => b.amount - a.amount)
    return this.recentSupportersCache
  }

  private async getZapEndpoint(profile: TProfile): Promise<null | {
    callback: string
    lnurl: string
  }> {
    try {
      let lnurl: string = ''

      // Some clients have incorrectly filled in the positions for lud06 and lud16
      if (!profile.lightningAddress) {
        return null
      }

      if (profile.lightningAddress.includes('@')) {
        const [name, domain] = profile.lightningAddress.split('@')
        lnurl = new URL(`/.well-known/lnurlp/${name}`, `https://${domain}`).toString()
      } else {
        const { words } = bech32.decode(profile.lightningAddress as any, 1000)
        const data = bech32.fromWords(words)
        lnurl = utf8Decoder.decode(data)
      }

      const res = await fetch(lnurl)
      const body = await res.json()

      if (body.allowsNostr !== false && body.callback) {
        return {
          callback: body.callback,
          lnurl
        }
      }
    } catch (err) {
      console.error(err)
    }

    return null
  }
}

const instance = new LightningService()
export default instance
