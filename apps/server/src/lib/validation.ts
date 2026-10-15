import { zValidator } from "@hono/zod-validator";
import type { ValidationTargets } from "hono";
import type { z } from "zod";
import { validationError } from "./errors";

/**
 * zValidator that reports failures as the protocol's ApiError (400 validation_error, Turkish message)
 * instead of @hono/zod-validator's default body.
 */
export function validate<Target extends keyof ValidationTargets, Schema extends z.ZodType>(target: Target, schema: Schema) {
  return zValidator(target, schema, (result) => {
    if (!result.success) throw validationError(result.error);
  });
}
