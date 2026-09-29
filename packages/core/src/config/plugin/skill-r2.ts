export * as ConfigSkillR2Plugin from "./skill-r2.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { WorkerdR2 } from "../../workerd/r2.js"
import { Skill } from "../../skill.js"
import { SkillFile } from "./skill-file.js"

export const Plugin = define({
  id: "opencode.config.skill.r2",
  effect: Effect.fn(function* (ctx) {
    const r2 = yield* WorkerdR2.Service
    if (!r2.available) return

    const skills: Skill.Info[] = []
    const names = yield* r2.listSkills().pipe(
      Effect.catchCause((cause) =>
        Effect.logError("failed to list R2 skills", { source: Skill.Source.key(Skill.R2Source.make({ type: "r2" })), cause }).pipe(
          Effect.as([] as ReadonlyArray<string>),
        ),
      ),
    )
    for (const name of names) {
      const content = yield* r2.read(`skills/${name}/SKILL.md`).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("failed to read R2 skill", { name, cause }).pipe(Effect.as(undefined)),
        ),
      )
      if (content === undefined) {
        yield* Effect.logWarning("R2 skill skipped", { name, reason: "SKILL.md missing" })
        continue
      }
      const parsed = SkillFile.parse(`skills://${name}`, `skills://${name}/SKILL.md`, new TextDecoder().decode(content.bytes))
      if (parsed._tag === "Skipped") {
        yield* Effect.logWarning("R2 skill file skipped", { name, reason: parsed.reason })
        continue
      }
      skills.push(parsed.skill)
    }
    yield* Effect.logDebug("R2 skill source loaded", {
      source: Skill.Source.key(Skill.R2Source.make({ type: "r2" })),
      skills: skills.map((skill) => skill.id),
    })
    yield* ctx.skill.transform((editor) => {
      for (const skill of skills) editor.add(skill)
    })
  }),
})
