import { z } from "zod";

/**
 * The fields consumed by TMIP are validated here. Every ffprobe field that is
 * not consumed yet is retained through passthrough objects so the adapter can
 * preserve the complete raw response for later additive normalization.
 */
const ffprobeStreamSchema = z
  .object({
    codec_type: z.string().min(1),
    codec_name: z.string().min(1).optional(),
    width: z.number().int().nonnegative().optional(),
    height: z.number().int().nonnegative().optional(),
    r_frame_rate: z.string().min(1).optional(),
    sample_rate: z.string().min(1).optional(),
    channels: z.number().int().nonnegative().optional(),
    pix_fmt: z.string().min(1).optional(),
    profile: z.string().min(1).optional(),
    field_order: z.string().min(1).optional(),
    tags: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

const ffprobeFormatSchema = z
  .object({
    duration: z.string().min(1),
    format_name: z.string().min(1).optional(),
    tags: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

export const ffprobeSchema = z
  .object({
    format: ffprobeFormatSchema,
    streams: z.array(ffprobeStreamSchema),
  })
  .passthrough();

export type FFprobeStream = z.infer<typeof ffprobeStreamSchema>;
export type FFprobeFormat = z.infer<typeof ffprobeFormatSchema>;
export type FFprobeOutput = z.infer<typeof ffprobeSchema>;

export function parseFFprobeJson(rawJson: string): FFprobeOutput {
  const parsed: unknown = JSON.parse(rawJson);
  return ffprobeSchema.parse(parsed);
}
