import { Skill } from "@novacode-ai/schema/skill"
import { Location } from "@novacode-ai/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError } from "../errors"
import { LocationQuery, locationQueryOpenApi } from "./location"

export const SkillGroup = HttpApiGroup.make("server.skill")
  .add(
    HttpApiEndpoint.get("skill.list", "/api/skill", {
      query: LocationQuery,
      success: Location.response(Schema.Array(Skill.Info)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.skill.list",
          summary: "List skills",
          description: "Retrieve currently registered skills.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("skill.create", "/api/skill", {
      query: LocationQuery,
      payload: Schema.Struct({
        name: Schema.String,
        description: Schema.optional(Schema.String),
        content: Schema.String,
      }),
      success: Skill.Info,
      error: InvalidRequestError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.skill.create",
          summary: "Create skill",
          description: "Create a new skill markdown file in the workspace.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.delete("skill.remove", "/api/skill", {
      query: Schema.Struct({
        ...LocationQuery.fields,
        name: Schema.String,
      }),
      success: HttpApiSchema.NoContent,
      error: InvalidRequestError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.skill.remove",
          summary: "Delete skill",
          description: "Delete an existing skill by name.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "skills",
      description: "Experimental skill routes.",
    }),
  )
