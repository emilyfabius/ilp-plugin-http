import * as Koa from 'koa'
import * as IlpPacket from 'ilp-packet'
import * as ILDCP from 'ilp-protocol-ildcp'
import * as EventEmitter from 'events'
import * as raw from 'raw-body'
import * as jwt from 'jsonwebtoken'
import * as http from 'http'
import fetch, { Response } from 'node-fetch'
import { URL } from 'url'
import Http2Client, {
  Http2FetchParams,
  Http2FetchResponse
} from './lib/http2'
import Auth from './lib/auth'

type FetchResponse = Http2FetchResponse | Response

const MAX_ILP_PACKET_LENGTH = 32767
const INVALID_SEGMENT = new RegExp('[^A-Za-z0-9_\\-]')

export interface PluginHttpOpts {
  multi?: boolean
  multiDelimiter?: string
  ildcp?: ILDCP.IldcpResponse

  incoming: {
    port: number,
    secret?: string, // JWT
    secretToken?: string
  },

  outgoing: {
    url: string,
    secret?: string, // JWT
    secretToken?: string,
    http2?: boolean,
    http2MaxRequestsPerSession?: number,
    name?: string,
    sendIlpDestination?: boolean
    tokenExpiry?: number
  }
}

interface Http2ClientMap {
  [key: string]: Http2Client
}

type PacketHandler = (data: Buffer) => Promise<Buffer>

class PluginHttp extends EventEmitter {
  private _connected: boolean
  private _multi: boolean
  private _multiDelimiter: string
  private _ildcp?: ILDCP.IldcpResponse
  private _port: number
  private _url: string
  private _http2: boolean
  private _http2Clients: Http2ClientMap
  private _http2MaxRequestsPerSession?: number
  private _name: string
  private _sendIlpDestination: boolean
  private _incomingAuth: Auth
  private _outgoingAuth: Auth
  private _dataHandler?: PacketHandler
  private _httpServer: http.Server
  private _app: Koa
  public static version: number

  constructor ({ multi, multiDelimiter, ildcp, incoming, outgoing }: PluginHttpOpts) {
    super()

    // TODO: validate args
    this._connected = false
    this._multi = !!multi
    this._multiDelimiter = multiDelimiter || '%'
    this._ildcp = ildcp

    // incoming
    this._port = incoming.port

    // outgoing
    this._url = outgoing.url
    this._http2 = !!outgoing.http2
    this._http2Clients = {}
    this._http2MaxRequestsPerSession = outgoing.http2MaxRequestsPerSession
    this._name = outgoing.name || String(this._port)
    this._sendIlpDestination = !!outgoing.sendIlpDestination

    this._incomingAuth = new Auth({
      jwtSecret: incoming.secret,
      staticToken: incoming.secretToken
    })
    this._outgoingAuth = new Auth({
      jwtSecret: outgoing.secret,
      jwtExpiry: outgoing.tokenExpiry,
      staticToken: outgoing.secretToken
    })
  }

  async connect (): Promise<void> {
    if (this._connected) return

    this._app = new Koa()
    this._app.use(async (ctx, next) => {
      if (ctx.method === 'GET') {
        ctx.body = 'OK'
        return
      }

      const verified = await this._verifyToken(ctx.get('authorization'))
      if (!verified) {
        ctx.throw(401, 'invalid authorization')
        return
      }

      if (!this._connected) {
        ctx.throw(502, 'server is closed')
        return
      }

      const packet = await raw(ctx.req, {
        limit: MAX_ILP_PACKET_LENGTH
      })

      if (this._multi) {
        const parsed = IlpPacket.deserializeIlpPrepare(packet)
        const name = ctx.get('ilp-peer-name')

        if (parsed.destination === 'peer.config') {
          const ildcp = await this._fetchIldcp()
          ctx.body = ILDCP.serializeIldcpResponse({
            ...ildcp,
            clientAddress: ildcp.clientAddress + '.' + name
          })
          return
        }
      }

      if (!this._dataHandler) {
        ctx.throw(502, 'no handler registered.')
        return
      }

      ctx.body = await this._dataHandler(packet)
    })

    this._httpServer = this._app.listen(this._port)
    this._connected = true
    this.emit('connect')
  }

  async disconnect (): Promise<void> {
    if (!this._connected) return

    for (const client of Object.values(this._http2Clients)) {
      client.close()
    }

    this._connected = false
    this._httpServer.close()
    this.emit('disconnect')
  }

  _verifyToken (token: string): Promise<boolean> {
    return this._incomingAuth.verifyToken(token)
  }

  _getToken (): Promise<string> {
    return this._outgoingAuth.getToken()
  }

  async _fetchIldcp (): Promise<ILDCP.IldcpResponse> {
    if (!this._ildcp) {
      if (this._dataHandler) {
        return (this._ildcp = await ILDCP.fetch(this._dataHandler))
      } else {
        throw new Error('data handler must be registered to fetch ildcp')
      }
    } else {
      return this._ildcp
    }
  }

  // Only used in multilateral situation
  async _generateUrl (destination: string): Promise<string> {
    const ildcp = await this._fetchIldcp()
    const segment = destination
      .substring(ildcp.clientAddress.length + 1)
      .split('.')[0]

    if (INVALID_SEGMENT.test(segment)) {
      throw new Error('invalid address segment')
    }

    // splice the address segment into the URL
    return this._url.replace(this._multiDelimiter, segment)
  }

  _getHttp2ClientForOrigin (origin: string): Http2Client {
    if (!this._http2Clients[origin]) {
      this._http2Clients[origin] = new Http2Client(origin, {
        maxRequestsPerSession: this._http2MaxRequestsPerSession
      })
    }

    return this._http2Clients[origin]
  }

  // TODO: type/interface for the fetch response?
  _fetch (url: string, opts: Http2FetchParams): Promise<FetchResponse> {
    if (this._http2) {
      const { origin, pathname } = new URL(url)

      // TODO: limit the number of clients cached?
      return this._getHttp2ClientForOrigin(origin).fetch(pathname, opts)
    } else {
      return fetch(url, opts) as Promise<FetchResponse>
    }
  }

  async sendData (data: Buffer): Promise<Buffer> {
    if (!this._connected) {
      throw new Error('plugin is not connected.')
    }

    const headers = {
      Authorization: await this._getToken(),
      'Content-Type': 'application/ilp+octet-stream',
      'ILP-Peer-Name': this._name
    }

    // url may be templated in multilateral environment
    let url = this._url
    if (this._multi || this._sendIlpDestination) {
      const { destination } = IlpPacket.deserializeIlpPrepare(data)

      if (this._sendIlpDestination) {
        headers['ILP-Destination'] = destination
      }

      if (this._multi) {
        url = await this._generateUrl(destination)
      }
    }

    const res = await this._fetch(url, {
      method: 'POST',
      body: data,
      headers
    })

    if (!res.ok) {
      throw new Error('failed to fetch. code=' + res.status)
    }

    // TODO: browser-safe way to do this, just in case
    return res.buffer()
  }

  // boilerplate methods
  isConnected (): boolean {
    return this._connected
  }

  registerDataHandler (handler: PacketHandler) {
    this._dataHandler = handler
  }

  deregisterDataHandler () {
    delete this._dataHandler
  }

  // no-ops; this plugin doesn't do settlement
  registerMoneyHandler () {
    return
  }

  deregisterMoneyHandler () {
    return
  }

  async sendMoney () {
    return
  }
}

PluginHttp.version = 2
export default PluginHttp
