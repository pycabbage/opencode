import { OpenCode, type OpenCodeEvent } from "@opencode/client"

export const worktree = "/tmp/opencode"
export const directory = `${worktree}/packages/tui`

export function json(data: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers)
  if (!headers.has("content-type")) headers.set("content-type", "application/json")
  return new Response(JSON.stringify(data), {
    ...init,
    headers,
  })
}

class EventSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readyState: number = EventSocket.CONNECTING

  send(_data: string) {}

  close() {
    if (this.readyState === EventSocket.CLOSED) return
    this.readyState = EventSocket.CLOSED
    this.dispatchEvent(new Event("close"))
  }

  open() {
    this.readyState = EventSocket.OPEN
    this.dispatchEvent(new Event("open"))
  }

  deliver(data: string) {
    this.dispatchEvent(new MessageEvent("message", { data }))
  }
}

type EventStreamTarget = { attach: (socket: EventSocket) => void }

const liveEventStreams: EventStreamTarget[] = []
const eventStreamsByHost = new Map<string, EventStreamTarget>()
let hostSequence = 0
let webSocketInstalled = false

function ensureEventSocketInstalled() {
  if (webSocketInstalled) return
  webSocketInstalled = true
  const real = globalThis.WebSocket as (new (url: string | URL, protocols?: string | string[]) => WebSocket) | undefined
  function RoutingSocket(this: unknown, url: string | URL, protocols?: string | string[]) {
    if (new URL(url).pathname !== "/api/event") {
      if (!real) throw new Error("No underlying WebSocket implementation is available in this environment")
      return new real(url, protocols)
    }
    const socket = new EventSocket()
    const hostname = new URL(url).hostname
    const target = eventStreamsByHost.get(hostname) ?? liveEventStreams[liveEventStreams.length - 1]
    queueMicrotask(() => target?.attach(socket))
    return socket
  }
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: RoutingSocket })
}

export function createEventStream(
  options: { readonly closeAfterConnect?: boolean; readonly autoConnect?: boolean } = {},
) {
  ensureEventSocketInstalled()
  const host = `event-stream-${++hostSequence}.test`
  const sockets = new Set<EventSocket>()
  const pending: string[] = []
  const autoConnect = options.autoConnect ?? true
  let connectionCount = 0
  const connectedChunk = () => JSON.stringify({ id: "evt_connected", type: "server.connected", data: {} })
  const target: EventStreamTarget = {
    attach(socket) {
      sockets.add(socket)
      connectionCount++
      socket.open()
      if (autoConnect) {
        socket.deliver(connectedChunk())
        for (const chunk of pending.splice(0)) socket.deliver(chunk)
      }
      if (options.closeAfterConnect) {
        sockets.delete(socket)
        socket.close()
      }
    },
  }
  liveEventStreams.push(target)
  eventStreamsByHost.set(host, target)

  return {
    host,
    attached() {
      return sockets.size
    },
    connections() {
      return connectionCount
    },
    connect() {
      for (const socket of sockets) socket.deliver(connectedChunk())
    },
    emit(event: OpenCodeEvent) {
      const chunk = JSON.stringify(event)
      if (sockets.size === 0) {
        pending.push(chunk)
        return
      }
      for (const socket of sockets) socket.deliver(chunk)
    },
    disconnect() {
      for (const socket of sockets) socket.close()
      sockets.clear()
    },
  }
}

export type FetchHandler = (url: URL, request: Request) => Response | undefined | Promise<Response | undefined>

export function createFetch(override?: FetchHandler, events?: ReturnType<typeof createEventStream>) {
  const session = [] as URL[]
  const host = events?.host
  async function fetch(input: RequestInfo | URL, init?: RequestInit) {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url)
    if (url.pathname === "/session") session.push(url)
    const overridden = await override?.(url, request)
    if (overridden) return overridden

    if (
      [
        "/agent",
        "/command",
        "/experimental/workspace",
        "/experimental/workspace/status",
        "/formatter",
        "/lsp",
      ].includes(url.pathname)
    )
      return json([])
    if (["/config", "/experimental/resource", "/mcp", "/provider/auth", "/session/status"].includes(url.pathname))
      return json({})
    if (url.pathname === "/config/providers") return json({ providers: {}, default: {} })
    if (url.pathname === "/experimental/console") return json({ consoleManagedProviders: [], switchableOrgCount: 0 })
    if (url.pathname === "/experimental/capabilities") return json({ backgroundSubagents: true })
    if (url.pathname === "/path") return json({ home: "", state: "", config: "", worktree, directory })
    if (url.pathname === "/api/location")
      return json({ directory, project: { id: "proj_test", directory: worktree, canonical: worktree } })
    if (url.pathname === "/api/plugin")
      return json({
        location: { directory, project: { id: "proj_test", directory: worktree, canonical: worktree } },
        data: [],
      })
    if (url.pathname === "/api/vcs")
      return json({
        location: { directory, project: { id: "proj_test", directory: worktree, canonical: worktree } },
        data: { branch: { current: "main", default: "main" } },
      })
    if (url.pathname === "/api/fs/list")
      return json({
        location: { directory, project: { id: "proj_test", directory: worktree, canonical: worktree } },
        data: [],
      })
    if (url.pathname === "/api/project") return json([])
    if (url.pathname === "/api/worktree") {
      if (request.method === "GET") return json([{ directory: worktree }])
      if (request.method === "POST") return json({ directory: `${worktree}/created` })
      return new Response(null, { status: 204 })
    }
    if (url.pathname === "/api/worktree/refresh") return new Response(null, { status: 204 })
    if (url.pathname === "/api/shell")
      return json({
        location: { directory, project: { id: "proj_test", directory: worktree, canonical: worktree } },
        data: [],
      })
    if (url.pathname === "/api/mcp")
      return json({
        location: { directory, project: { id: "proj_test", directory: worktree, canonical: worktree } },
        data: [],
      })
    if (url.pathname === "/api/mcp/resource")
      return json({
        location: { directory, project: { id: "proj_test", directory: worktree, canonical: worktree } },
        data: { resources: [], templates: [] },
      })
    if (url.pathname === "/api/session") return json({ data: [], cursor: {} })
    if (url.pathname === "/api/config") return json([])
    if (url.pathname === "/api/session/active") return json({ data: {} })
    if (request.method === "POST" && /^\/api\/session\/[^/]+\/model$/.test(url.pathname))
      return new Response(null, { status: 204 })
    if (url.pathname === "/api/permission/request")
      return json({
        location: { directory, project: { id: "proj_test", directory: worktree, canonical: worktree } },
        data: [],
      })
    if (url.pathname === "/api/form")
      return json({ location: { directory, project: { id: "proj_test", directory: worktree } }, data: [] })
    if (/^\/api\/session\/[^/]+\/form$/.test(url.pathname)) return json({ data: [] })
    if (/^\/api\/experimental\/session\/[^/]+\/terminal$/.test(url.pathname)) return json({ data: [] })
    if (
      ["/api/agent", "/api/model", "/api/provider", "/api/integration", "/api/command", "/api/skill"].includes(
        url.pathname,
      )
    )
      return json({
        location: { directory, project: { id: "proj_test", directory: worktree, canonical: worktree } },
        data: [],
      })
    if (url.pathname === "/api/reference")
      return json({ location: { directory, project: { id: "proj_test", directory, canonical: directory } }, data: [] })
    if (url.pathname === "/api/websearch/provider") {
      return json({ location: { directory, project: { id: "proj_test", directory, canonical: directory } }, data: [] })
    }
    if (url.pathname === "/provider") return json({ all: [], default: {}, connected: [] })
    if (url.pathname === "/session") return json([])
    if (url.pathname === "/vcs") return json({ branch: "main" })
    if (url.pathname === "/api/experimental/migration/v1") return json({ status: "completed" })
    throw new Error(`unexpected request: ${url.pathname}`)
  }
  fetch.preconnect = () => {}
  if (host) (fetch as { eventStreamHost?: string }).eventStreamHost = host
  return { fetch, session }
}

export function createApi(fetch: typeof globalThis.fetch) {
  const host = (fetch as { eventStreamHost?: string }).eventStreamHost
  return OpenCode.make({ baseUrl: host ? `http://${host}` : "http://test", fetch })
}
