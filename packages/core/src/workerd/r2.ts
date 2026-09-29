export * as WorkerdR2 from "./r2.js"

import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"

// Minimal structural types for the Workers R2 bucket API so this module does
// not depend on @cloudflare/workers-types (whose ambient globals conflict with
// @types/bun). Shapes match the R2Bucket, R2Object, R2ObjectBody, and R2Objects
// declarations in @cloudflare/workers-types; only the members used here remain.
export interface Object {
  readonly key: string
  readonly size: number
}

export interface ObjectBody extends Object {
  readonly bytes: () => Promise<Uint8Array>
  readonly text: () => Promise<string>
}

export interface Objects {
  readonly objects: readonly Object[]
  readonly delimitedPrefixes: readonly string[]
  readonly truncated: boolean
  readonly cursor?: string
}

export interface ListOptions {
  readonly limit?: number
  readonly prefix?: string
  readonly cursor?: string
  readonly delimiter?: string
  readonly startAfter?: string
}

/** The R2 bucket surface used by opencode; structurally compatible with `R2Bucket`. */
export interface Bucket {
  readonly get: (key: string) => Promise<ObjectBody | null>
  readonly list: (options?: ListOptions) => Promise<Objects>
}

export class Failure extends Schema.TaggedError<Failure>()("WorkerdR2.Failure", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message() {
    return `WorkerdR2 ${this.operation} failed: ${String(this.cause)}`
  }
}

export interface ObjectContent {
  readonly size: number
  readonly bytes: Uint8Array
}

export interface Interface {
  /** True when an R2 bucket backing skills, the durable global AGENTS.md, and the durable opencode config is bound. */
  readonly available: boolean
  /** Skill directory names under `skills/`, derived from `skills/<name>/` prefixes. */
  readonly listSkills: () => Effect.Effect<ReadonlyArray<string>, Failure>
  /** Object keys beginning with the prefix, without the leading prefix. */
  readonly listObjects: (prefix: string) => Effect.Effect<ReadonlyArray<string>, Failure>
  /** Reads one object; undefined when the key does not exist. */
  readonly read: (key: string) => Effect.Effect<ObjectContent | undefined, Failure>
  /** Reads the durable opencode config document at its fixed key; undefined when none is stored. */
  readonly readConfig: () => Effect.Effect<string | undefined, Failure>
}

const configKey = "config/opencode.json"

export class Service extends Context.Service<Service, Interface>()("@opencode/WorkerdR2") {}

const listLimit = 1_000
const maxPages = 100

const failure = (operation: string) => (cause: unknown) => new Failure({ operation, cause })

const layerFrom = (bucket: Bucket | undefined) =>
  Layer.succeed(
    Service,
    Service.of(
      bucket === undefined
        ? {
            available: false,
            listSkills: () => Effect.fail(new Failure({ operation: "listSkills", cause: "no R2 bucket bound" })),
            listObjects: () => Effect.fail(new Failure({ operation: "listObjects", cause: "no R2 bucket bound" })),
            read: () => Effect.fail(new Failure({ operation: "read", cause: "no R2 bucket bound" })),
            readConfig: () => Effect.fail(new Failure({ operation: "readConfig", cause: "no R2 bucket bound" })),
          }
        : {
            available: true,
            listSkills: Effect.fn("WorkerdR2.listSkills")(function* () {
              const names: string[] = []
              let cursor: string | undefined
              for (let page = 0; page < maxPages; page++) {
                const result = yield* Effect.tryPromise({
                  try: () => bucket.list({ prefix: "skills/", delimiter: "/", limit: listLimit, cursor }),
                  catch: failure("listSkills"),
                })
                for (const prefix of result.delimitedPrefixes) {
                  const name = prefix.slice("skills/".length, -1)
                  if (name.length > 0 && !name.includes("/")) names.push(name)
                }
                if (!result.truncated) return names.toSorted()
                cursor = result.cursor
              }
              return yield* new Failure({ operation: "listSkills", cause: `exceeded ${maxPages} list pages` })
            }),
            listObjects: Effect.fn("WorkerdR2.listObjects")(function* (prefix: string) {
              const keys: string[] = []
              let cursor: string | undefined
              for (let page = 0; page < maxPages; page++) {
                const result = yield* Effect.tryPromise({
                  try: () => bucket.list({ prefix, limit: listLimit, cursor }),
                  catch: failure("listObjects"),
                })
                keys.push(...result.objects.map((object) => object.key))
                if (!result.truncated) return keys.map((key) => key.slice(prefix.length)).toSorted()
                cursor = result.cursor
              }
              return yield* new Failure({ operation: "listObjects", cause: `exceeded ${maxPages} list pages` })
            }),
            read: Effect.fn("WorkerdR2.read")(function* (key: string) {
              const body = yield* Effect.tryPromise({
                try: () => bucket.get(key),
                catch: failure("read"),
              })
              if (body === null) return undefined
              const bytes = yield* Effect.tryPromise({
                try: () => body.bytes(),
                catch: failure("read"),
              })
              return { size: body.size, bytes } satisfies ObjectContent
            }),
            readConfig: Effect.fn("WorkerdR2.readConfig")(function* () {
              const body = yield* Effect.tryPromise({
                try: () => bucket.get(configKey),
                catch: failure("readConfig"),
              })
              if (body === null) return undefined
              return yield* Effect.tryPromise({
                try: () => body.text(),
                catch: failure("readConfig"),
              })
            }),
          },
    ),
  )

/** The default node: no bucket bound, so R2-backed sources report themselves unavailable. */
export const node = makeGlobalNode({ service: Service, layer: layerFrom(undefined), deps: [] })

/** Builds a node replacement backed by a bound R2 bucket. */
export const layer = (bucket: Bucket) => layerFrom(bucket)
