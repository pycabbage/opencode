export class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readonly url: string
  readonly sent: string[] = []
  readyState = FakeWebSocket.CONNECTING

  constructor(url: string | URL) {
    super()
    this.url = String(url)
    FakeWebSocket.instances.push(this)
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.dispatchEvent(new Event("close"))
  }

  open() {
    this.readyState = FakeWebSocket.OPEN
    this.dispatchEvent(new Event("open"))
  }

  message(data: string) {
    this.dispatchEvent(new MessageEvent("message", { data }))
  }
}

export function installFakeWebSocket() {
  const original = Object.getOwnPropertyDescriptor(globalThis, "WebSocket")
  FakeWebSocket.instances = []
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FakeWebSocket })
  return () => {
    if (original) Object.defineProperty(globalThis, "WebSocket", original)
    else delete (globalThis as { WebSocket?: unknown }).WebSocket
  }
}

export async function withFakeWebSocket<A>(run: () => Promise<A>) {
  const restore = installFakeWebSocket()
  try {
    return await run()
  } finally {
    restore()
  }
}
