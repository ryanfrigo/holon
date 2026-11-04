import net from 'node:net'
import { EventEmitter } from 'node:events'

export class HolonClient extends EventEmitter {
  private nextId = 1
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()

  private sock: net.Socket

  private constructor(sock: net.Socket) {
    super()
    this.sock = sock
    let buf = ''
    sock.on('data', chunk => {
      buf += chunk
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl))
        buf = buf.slice(nl + 1)
        if (msg.event) this.emit(msg.event, msg.payload)
        else {
          const p = this.pending.get(msg.id)
          this.pending.delete(msg.id)
          if (msg.error) p?.reject(new Error(msg.error))
          else p?.resolve(msg.result)
        }
      }
    })
    sock.on('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('holon daemon disconnected'))
      this.pending.clear()
      this.emit('close')
    })
  }

  static connect(socketPath: string): Promise<HolonClient> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(socketPath)
      sock.once('connect', () => resolve(new HolonClient(sock)))
      sock.once('error', reject)
    })
  }

  get closed() {
    return this.sock.destroyed
  }

  call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    // A call on a dead connection would wait forever: fail it so the caller can reconnect.
    if (this.sock.destroyed) return Promise.reject(new Error('holon daemon disconnected'))
    const id = this.nextId++
    this.sock.write(JSON.stringify({ id, method, params }) + '\n')
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }

  close() {
    this.sock.end()
  }
}
