#!/usr/bin/env node
// Regenerates the live channels' looping segments (media/live/canal-N/seg0.ts .. seg2.ts), which are
// committed so server.mjs needs nothing but Node. Needs ffmpeg; run it only to change them:
//
//   node media/make-live.mjs
//
// Each channel is its own card from artwork.mjs (the channel's colour and name, "EN VIVO" on top)
// with a white bar sweeping along the bottom so it visibly moves, and a tone of its own pitch, so
// zapping between channels is unmistakable by eye and by ear. 320x180 at 10 fps, 6 seconds cut into
// three 2-second MPEG-TS segments: about 12 KB each.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { artwork } from "../artwork.mjs";
import { LIVE_CHANNELS, LIVE_SEGMENTS, LIVE_SEGMENT_SECONDS } from "../server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "kino-live-"));
try {
  LIVE_CHANNELS.forEach(({ id, title }, i) => {
    const card = join(scratch, id + ".png");
    writeFileSync(card, artwork({ id, title, label: "En vivo", shape: "backdrop" }));
    const out = join(here, "live", id);
    mkdirSync(out, { recursive: true });
    const seconds = LIVE_SEGMENTS * LIVE_SEGMENT_SECONDS;
    execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-loop", "1", "-framerate", "10", "-i", card,
      "-f", "lavfi", "-i", `color=c=white:s=40x8:r=10`,
      "-f", "lavfi", "-i", `sine=frequency=${300 + i * 90}:sample_rate=44100`,
      "-filter_complex", `[0]scale=320:180,format=yuv420p[bg];[bg][1]overlay=x='mod(t*${320 / seconds}\\,320)':y=H-12:shortest=1[v]`,
      "-map", "[v]", "-map", "2:a", "-t", String(seconds),
      // One reference frame and no B-frames, on purpose: "-preset veryslow" wrote max_num_ref_frames=16
      // and max_dec_frame_buffering=16 into the SPS, and a TV's hardware decoder (KALLEY, media3) then
      // held every frame back waiting to fill a 16-picture buffer -- endless spinner, while a phone
      // played it. A closed 2-second GOP per segment, each segment opening on an IDR with PAT/PMT.
      "-c:v", "libx264", "-profile:v", "baseline", "-pix_fmt", "yuv420p", "-preset", "medium", "-crf", "38",
      "-refs", "1", "-bf", "0", "-x264-params", "ref=1:bframes=0",
      "-g", String(10 * LIVE_SEGMENT_SECONDS), "-keyint_min", String(10 * LIVE_SEGMENT_SECONDS), "-sc_threshold", "0",
      "-flags", "+cgop",
      "-c:a", "aac", "-b:a", "16k", "-ac", "1",
      // The hls muxer keeps one MPEG-TS muxer across the three files, so the continuity counters run on
      // from seg0 into seg1 into seg2 (the segment muxer restarted them at 0 in every file). Its own
      // playlist is thrown away: server.mjs writes the live one.
      "-f", "hls", "-hls_time", String(LIVE_SEGMENT_SECONDS), "-hls_list_size", "0",
      "-hls_flags", "independent_segments", "-hls_segment_type", "mpegts",
      "-mpegts_flags", "resend_headers",
      "-hls_segment_filename", join(out, "seg%d.ts"),
      join(scratch, id + ".m3u8"),
    ]);
  });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
