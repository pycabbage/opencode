import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Environment } from "@opencode/core/environment/index"
import { FileAccess } from "@opencode/core/file-access"
import { Location } from "@opencode/core/location"
import { Permission } from "@opencode/core/permission"
import { AbsolutePath } from "@opencode/core/schema"
import { Skill } from "@opencode/core/skill"
import { WorkerdR2 } from "@opencode/core/workerd/r2"
import { ReadToolFileSystem } from "@opencode/core/tool/read-filesystem"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { tempLocationLayer } from "../fixture/location"
import { it } from "../lib/effect"
import { permissionLayer } from "../lib/permission"

class MemoryBucket {
  readonly objects = new Map<string, Uint8Array>()
  readonly listCalls: Array<WorkerdR2.ListOptions | undefined> = []

  constructor(
    readonly pageSize = 2,
    entries: Record<string, string> = {},
  ) {
    for (const [key, value] of Object.entries(entries)) this.objects.set(key, new TextEncoder().encode(value))
  }

  private paginate(all: string[], options?: WorkerdR2.ListOptions) {
    const start = options?.cursor === undefined ? 0 : all.indexOf(options.cursor) + 1
    const limit = Math.min(options?.limit ?? Number.POSITIVE_INFINITY, this.pageSize)
    const page = all.slice(start, start + limit)
    const truncated = start + page.length < all.length
    return { page, truncated }
  }

  async get(key: string) {
    const bytes = this.objects.get(key)
    if (bytes === undefined) return null
    return {
      key,
      size: bytes.length,
      bytes: async () => bytes,
      text: async () => new TextDecoder().decode(bytes),
    }
  }

  async list(options?: WorkerdR2.ListOptions) {
    this.listCalls.push(options)
    const prefix = options?.prefix ?? ""
    const keys = Array.from(this.objects.keys()).sort()
    if (options?.delimiter !== undefined) {
      const prefixes = new Set<string>()
      for (const key of keys) {
        if (!key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length)
        const cut = rest.indexOf(options.delimiter)
        if (cut === -1) continue
        prefixes.add(prefix + rest.slice(0, cut + options.delimiter.length))
      }
      const { page, truncated } = this.paginate(Array.from(prefixes).sort(), options)
      return {
        objects: [],
        delimitedPrefixes: page,
        truncated,
        ...(truncated ? { cursor: page.at(-1) } : {}),
      }
    }
    const matching = keys.filter((key) => key.startsWith(prefix))
    const { page, truncated } = this.paginate(matching, options)
    return {
      objects: page.map((key) => ({ key, size: this.objects.get(key)!.length })),
      delimitedPrefixes: [],
      truncated,
      ...(truncated ? { cursor: page.at(-1) } : {}),
    }
  }
}

const entries = {
  "agents/AGENTS.md": "# Global rules\nfrom R2",
  "skills/alpha/SKILL.md": "---\nname: Alpha\ndescription: Alpha things\n---\nAlpha guidance",
  "skills/beta/SKILL.md": "Beta guidance",
  "skills/beta/reference/notes.md": "beta notes",
}

const bucket = () => new MemoryBucket(2, entries)

describe("WorkerdR2", () => {
  it.effect("reports unavailable without a bound bucket", () =>
    Effect.gen(function* () {
      const r2 = yield* WorkerdR2.Service
      expect(r2.available).toBe(false)
    }).pipe(Effect.provide(LayerNode.compile(WorkerdR2.node))))

  it.effect("lists skill names across paginated delimiter listings", () =>
    Effect.gen(function* () {
      const memory = new MemoryBucket(1, entries)
      const r2 = yield* Effect.gen(function* () {
        return yield* WorkerdR2.Service
      }).pipe(Effect.provide(WorkerdR2.layer(memory)))
      const names = yield* r2.listSkills()
      expect(Array.from(names)).toEqual(["alpha", "beta"])
      expect(memory.listCalls.length).toBe(2)
      for (const call of memory.listCalls) {
        expect(call).toMatchObject({ prefix: "skills/", delimiter: "/" })
      }
    }))

  it.effect("lists object keys relative to the prefix", () =>
    Effect.gen(function* () {
      const r2 = yield* WorkerdR2.Service
      expect(Array.from(yield* r2.listObjects("skills/beta/"))).toEqual(["SKILL.md", "reference/notes.md"])
    }).pipe(Effect.provide(WorkerdR2.layer(bucket()))))

  it.effect("reads objects and reports missing keys as undefined", () =>
    Effect.gen(function* () {
      const r2 = yield* WorkerdR2.Service
      const hit = yield* r2.read("skills/beta/SKILL.md")
      expect(hit?.size).toBe("Beta guidance".length)
      expect(new TextDecoder().decode(hit!.bytes)).toBe("Beta guidance")
      expect(yield* r2.read("skills/beta/missing.md")).toBeUndefined()
    }).pipe(Effect.provide(WorkerdR2.layer(bucket()))))

  it.effect("keys R2 sources in the shared skill schema", () =>
    Effect.sync(() => {
      const source = Skill.R2Source.make({ type: "r2" })
      expect(Skill.Source.key(source)).toBe("r2:skills")
      expect(Skill.Source.equals(source, Skill.R2Source.make({ type: "r2" }))).toBe(true)
      expect(
        Skill.Source.equals(source, Skill.DirectorySource.make({ type: "directory", path: AbsolutePath.make("/tmp") })),
      ).toBe(false)
    }))
})

describe("Skill.prepare with an R2 skill", () => {
  it.effect("lists attachments through the R2 source", () =>
    Effect.gen(function* () {
      const r2 = yield* WorkerdR2.Service
      const skill = Skill.Info.make({
        id: Skill.ID.make("beta"),
        name: Skill.Name.make("beta"),
        path: AbsolutePath.make("skills://beta/SKILL.md"),
        content: "Beta guidance",
      })
      const prepared = yield* Skill.prepare(
        {
          scan: () => Effect.die(new Error("fs.scan must not run for R2 skills")),
        } as never,
        skill,
        r2,
      )
      expect(prepared.directory).toBe("skills://beta")
      expect(prepared.output).toContain("<file>skills://beta/reference/notes.md</file>")
      expect(prepared.output).toContain("Base directory for this skill: skills://beta")
    }).pipe(Effect.provide(WorkerdR2.layer(bucket()))))
})

describe("FileAccess.resolve with skills://", () => {
  it.effect("resolves skills:// addresses lexically without touching the location", () =>
    Effect.gen(function* () {
      const access = yield* FileAccess.Service
      const target = yield* access.resolve({ path: "skills://beta/SKILL.md", kind: "file" })
      expect(target.absolute).toBe(AbsolutePath.make("skills://beta/SKILL.md"))
      expect(target.resource).toBe("skills://beta/SKILL.md")
      expect(target.externalDirectory).toBeUndefined()
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(LayerNode.group([FileAccess.node, Location.node]), [
          Location.node.replace(tempLocationLayer),
          Permission.node.replace(permissionLayer()),
        ]),
      ),
    ))
})

describe("ReadToolFileSystem with skills://", () => {
  const unreachable = () => {
    throw new Error("the location environment must not be used for skills:// paths")
  }
  const environmentWithoutPlane = Layer.succeed(
    Environment.Service,
    Environment.Service.of({
      files: new Proxy({}, { get: unreachable }) as never,
      spawner: new Proxy({}, { get: unreachable }) as never,
    }),
  )
  const provide = (bucket: WorkerdR2.Bucket) =>
    Effect.provide(
      AppNodeBuilder.build(ReadToolFileSystem.node, [
        WorkerdR2.node.replace(WorkerdR2.layer(bucket)),
        Environment.node.replace(environmentWithoutPlane),
      ]),
    )

  it.effect("reads an R2 object as text", () =>
    Effect.gen(function* () {
      const reader = yield* ReadToolFileSystem.Service
      const content = yield* reader.read(AbsolutePath.make("skills://beta/SKILL.md"), "skills://beta/SKILL.md")
      expect(content).toMatchObject({ type: "file", content: "Beta guidance", encoding: "utf8" })
    }).pipe(provide(bucket())))

  it.effect("pages a large R2 object", () =>
    Effect.gen(function* () {
      const reader = yield* ReadToolFileSystem.Service
      const content = yield* reader.read(AbsolutePath.make("skills://beta/big.md"), "skills://beta/big.md", {
        offset: 2,
        limit: 3,
      })
      expect(content).toMatchObject({ type: "text-page", content: "line 2\nline 3\nline 4", offset: 2, truncated: true })
    }).pipe(
      provide(
        new MemoryBucket(2, {
          "skills/beta/big.md": Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join("\n"),
        }),
      ),
    ))

  it.effect("lists skill roots and nested directories", () =>
    Effect.gen(function* () {
      const reader = yield* ReadToolFileSystem.Service
      const root = yield* reader.read(AbsolutePath.make("skills://"), "skills://")
      expect(root).toMatchObject({
        type: "list-page",
        entries: [
          { path: "alpha/", type: "directory" },
          { path: "beta/", type: "directory" },
        ],
      })
      const nested = yield* reader.read(AbsolutePath.make("skills://beta/"), "skills://beta/")
      expect(nested).toMatchObject({
        type: "list-page",
        entries: [
          { path: "reference/", type: "directory" },
          { path: "SKILL.md", type: "file" },
        ],
      })
    }).pipe(provide(bucket())))

  it.effect("fails with NotFound for missing objects", () =>
    Effect.gen(function* () {
      const reader = yield* ReadToolFileSystem.Service
      const error = yield* reader
        .read(AbsolutePath.make("skills://beta/missing.md"), "skills://beta/missing.md")
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(Environment.NotFound)
    }).pipe(provide(bucket())))
})
