/**
 * ffprobe wrapper: reads the facts the processing step needs (codec, profile, level, size, frame
 * rate, rotation, audio presence, duration) from `ffprobe -print_format json`.
 */
import { z } from "zod";
import { env } from "../env";
import { runProcess } from "../lib/process-runner";

const ProbeStream = z.object({
  index: z.number(),
  codec_type: z.string().optional(),
  codec_name: z.string().optional(),
  profile: z.string().optional(),
  level: z.number().optional(),
  pix_fmt: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  avg_frame_rate: z.string().optional(),
  r_frame_rate: z.string().optional(),
  sample_aspect_ratio: z.string().optional(),
  field_order: z.string().optional(),
  bit_rate: z.string().optional(),
  duration: z.string().optional(),
  channels: z.number().optional(),
  sample_rate: z.string().optional(),
  disposition: z.record(z.string(), z.number()).optional(),
  tags: z.record(z.string(), z.string()).optional(),
  side_data_list: z.array(z.object({ side_data_type: z.string().optional(), rotation: z.number().optional() })).optional(),
});
type ProbeStream = z.infer<typeof ProbeStream>;

const ProbeOutput = z.object({
  streams: z.array(ProbeStream).default([]),
  format: z
    .object({
      format_name: z.string().optional(),
      duration: z.string().optional(),
      bit_rate: z.string().optional(),
      size: z.string().optional(),
    })
    .optional(),
});

export interface Rational {
  num: number;
  den: number;
}

export interface VideoStreamInfo {
  /** Absolute stream index, for -map 0:<index>. */
  index: number;
  codec: string;
  profile: string | null;
  /** H.264 level ×10 as ffprobe reports it, e.g. 41 for 4.1. */
  level: number | null;
  pixFmt: string | null;
  width: number;
  height: number;
  /** Average frame rate; null when ffprobe cannot tell. */
  frameRate: Rational | null;
  /** Sample (pixel) aspect ratio; null means square / unknown. */
  sampleAspect: Rational | null;
  /** Display rotation in degrees (0, 90, 180, 270). */
  rotation: number;
  interlaced: boolean;
  /** Video bit rate in bit/s if known. */
  bitRate: number | null;
}

export interface AudioStreamInfo {
  index: number;
  codec: string;
  channels: number | null;
  bitRate: number | null;
}

export interface ProbeResult {
  formatName: string;
  durationSec: number | null;
  /** Container bit rate in bit/s if known. */
  bitRate: number | null;
  video: VideoStreamInfo | null;
  audio: AudioStreamInfo | null;
}

export function parseRational(value: string | undefined): Rational | null {
  if (!value) return null;
  const match = /^(\d+)[/:](\d+)$/.exec(value.trim());
  if (!match) return null;
  const num = Number(match[1]);
  const den = Number(match[2]);
  if (!Number.isFinite(num) || !Number.isFinite(den) || num <= 0 || den <= 0) return null;
  return { num, den };
}

export const rationalValue = (r: Rational): number => r.num / r.den;

function positiveNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function rotationOf(stream: ProbeStream): number {
  const fromSideData = stream.side_data_list?.find((d) => d.rotation !== undefined)?.rotation;
  const raw = fromSideData ?? positiveNumber(stream.tags?.rotate) ?? 0;
  // Display matrices say -90 for what the old "rotate" tag called 270.
  return ((Math.round(raw) % 360) + 360) % 360;
}

function toVideo(stream: ProbeStream): VideoStreamInfo | null {
  if (!stream.width || !stream.height || !stream.codec_name) return null;
  const sar = parseRational(stream.sample_aspect_ratio);
  const fieldOrder = stream.field_order ?? "unknown";
  return {
    index: stream.index,
    codec: stream.codec_name,
    profile: stream.profile ?? null,
    level: stream.level !== undefined && stream.level > 0 ? stream.level : null,
    pixFmt: stream.pix_fmt ?? null,
    width: stream.width,
    height: stream.height,
    frameRate: parseRational(stream.avg_frame_rate) ?? parseRational(stream.r_frame_rate),
    sampleAspect: sar && sar.num !== sar.den ? sar : null,
    rotation: rotationOf(stream),
    interlaced: !["progressive", "unknown"].includes(fieldOrder),
    bitRate: positiveNumber(stream.bit_rate),
  };
}

/** Runs ffprobe on a file. Throws (ProcessError) when ffprobe cannot read it at all. */
export async function probeMedia(file: string, signal?: AbortSignal): Promise<ProbeResult> {
  const { stdout } = await runProcess(
    env.FFPROBE_PATH,
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
    { signal },
  );
  const output = ProbeOutput.parse(JSON.parse(stdout));
  // Cover art in MP4/MKV shows up as a one-frame video stream marked attached_pic; it is not the video.
  const videoStream = output.streams.find((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
  const audioStream = output.streams.find((s) => s.codec_type === "audio");
  const streamDuration = videoStream ? positiveNumber(videoStream.duration) : null;
  return {
    formatName: output.format?.format_name ?? "",
    durationSec: positiveNumber(output.format?.duration) ?? streamDuration,
    bitRate: positiveNumber(output.format?.bit_rate),
    video: videoStream ? toVideo(videoStream) : null,
    audio:
      audioStream && audioStream.codec_name
        ? {
            index: audioStream.index,
            codec: audioStream.codec_name,
            channels: audioStream.channels ?? null,
            bitRate: positiveNumber(audioStream.bit_rate),
          }
        : null,
  };
}

/**
 * Largest gap in seconds between keyframes of one video stream, read from packet flags (demux only,
 * no decoding, so it stays fast for long files). The stretches before the first and after the last
 * keyframe count as gaps too: a file with a single keyframe has one long GOP. Null if no keyframes.
 */
export async function maxKeyframeGapSec(file: string, streamIndex: number, signal?: AbortSignal): Promise<number | null> {
  // An object, not loose `let`s: TypeScript does not see assignments made inside the callback.
  const state = {
    minPts: Number.POSITIVE_INFINITY,
    maxPts: Number.NEGATIVE_INFINITY,
    firstKey: null as number | null,
    lastKey: null as number | null,
    maxGap: 0,
  };
  await runProcess(
    env.FFPROBE_PATH,
    ["-v", "error", "-select_streams", String(streamIndex), "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0", file],
    {
      signal,
      onLine: (line) => {
        // "<pts_time>,<flags>", e.g. "2.000000,K__"
        const [time, flags = ""] = line.split(",");
        const t = Number(time);
        if (time === undefined || time === "" || !Number.isFinite(t)) return;
        state.minPts = Math.min(state.minPts, t);
        state.maxPts = Math.max(state.maxPts, t);
        if (!flags.startsWith("K")) return;
        state.firstKey ??= t;
        if (state.lastKey !== null) state.maxGap = Math.max(state.maxGap, t - state.lastKey);
        state.lastKey = t;
      },
    },
  );
  const { firstKey, lastKey } = state;
  if (firstKey === null || lastKey === null) return null;
  return Math.max(state.maxGap, firstKey - state.minPts, state.maxPts - lastKey);
}
