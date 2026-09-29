import { Effect } from "effect"
import { InstructionDiscovery } from "../../instruction-discovery.js"
import { AbsolutePath } from "../../schema.js"
import { WorkerdR2 } from "../../workerd/r2.js"
import type { Source } from "./global-instruction-source.js"

const path = AbsolutePath.make("r2://agents/AGENTS.md")

export const read: Source["read"] = () =>
  Effect.gen(function* () {
    const r2 = yield* WorkerdR2.Service
    if (!r2.available) return undefined
    const content = yield* r2.read("agents/AGENTS.md").pipe(
      Effect.catchCause((cause) =>
        Effect.logError("failed to read R2 global AGENTS.md", { key: "agents/AGENTS.md", cause }).pipe(
          Effect.as(undefined),
        ),
      ),
    )
    if (content === undefined) return undefined
    return new InstructionDiscovery.File({
      path,
      content: new TextDecoder().decode(content.bytes),
    })
  })
