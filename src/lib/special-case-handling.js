// Some Samsung Voice Recorder .m4a files are unplayable and untranscribable
// even though they look intact: Samsung's recorder writes the sample index
// (`moov`) at the END of the file, so if the copy/sync off the phone (or a
// OneDrive/cloud upload) is interrupted, `mdat` (the actual audio) survives
// but the index is truncated. No player or decoder - not VLC, not Windows
// Media Player, not ffmpeg/ffprobe - can find frame boundaries without that
// index, so the file throws on both playback and `vno transcribe` despite
// being visually identical to a working recording.
//
// The observed failure shape is always the same, and it's specific: the cut
// lands inside `stsz` (the per-sample size table), which is the largest atom
// in the index and sits near the end of `moov`. That means `stsd` (the codec
// config) and `stts` (the sample *count* and timing) survive intact, while
// `stsz`'s tail plus `stsc`/`stco` are gone. So the codec, the sample rate,
// the channel count and the exact number of audio frames are all still
// readable - the only thing genuinely missing is where each frame starts.
//
// Recovering those boundaries used to look like it needed a real AAC decoder,
// because an AAC `raw_data_block` (unlike ADTS) carries no length field and
// can't be found by byte-scanning. That's true, but vno already ships one:
// **ffmpeg's AAC decoder walks concatenated raw_data_blocks by itself.** Given
// an MP4 whose `stsz` declares a single sample spanning the whole `mdat`,
// libavcodec decodes a frame, reports how many bytes it consumed, and
// libavformat re-feeds the remainder - repeatedly, to the end of the buffer.
// So the repair is just: rebuild a minimal, valid MP4 around the surviving
// `mdat` as one giant sample, and let ffmpeg re-frame it.
//
// That makes this deterministic rather than a heuristic search: the frame
// count ffmpeg recovers is checked against the count `stts` recorded before
// the file was cut, so a successful repair is *verified* to have got every
// frame back, not merely assumed to have. It also removes the optional
// `koffi`+libfaad2 FFI path an earlier version of this module used, which was
// never satisfiable on Windows (where these files actually turn up) and only
// ever recovered the prefix of the recording that survived in `stsz`.
//
// Cost of the approach: ffmpeg re-encodes rather than copying frames, since
// nothing but the decoder knows where the recovered frames begin, so the
// repaired copy is one AAC generation removed from the original. For voice
// notes - which whisper downmixes to 16kHz mono anyway - that's inaudible,
// and the alternative is recovering nothing at all.
//
// This stays out of the normal import/transcribe path on purpose: it's only
// ever invoked from a catch block, after ffmpeg/ffprobe has already failed on
// a file, never speculatively. If the file doesn't match this failure shape,
// `repairSamsungM4A` returns `null` and the caller proceeds with the original
// file/error exactly as it would have without this module.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { which } from "./setup.js";

const execFileAsync = promisify(execFile);

// A repair replaces the recording *in place*, so the working file always keeps
// the name the user knows it by - nothing downstream has to know a repair ever
// happened, and a transcript, a bookmark or a shell command that named the file
// still names the right thing afterwards.
//
// The damaged file isn't destroyed, it's renamed to `<name>.original.m4a`. It's
// the only copy of the recorder's own metadata and the surviving part of the
// real index, so it's worth keeping until the user says otherwise - which they
// do through `vno cleanup --originals` / the cleanup dialog's checkbox. Those
// backups are hidden from `findAudioFiles`, so they never appear as a second
// note beside the recording they came from.
export const ORIGINAL_SUFFIX = ".original.m4a";

/** Where the pre-repair copy of `filePath` is kept (whether or not it exists yet). */
export function originalBackupFor(filePath) {
  return path.join(path.dirname(filePath), path.basename(filePath, path.extname(filePath)) + ORIGINAL_SUFFIX);
}

/** Whether a bare filename is a kept-aside pre-repair original, not a recording. */
export function isOriginalBackup(name) {
  return name.toLowerCase().endsWith(ORIGINAL_SUFFIX);
}

/**
 * The pre-repair originals sitting beside any of `audioFiles`, for the cleanup
 * flows to offer up. Derived from the recordings rather than by walking the
 * target again: a backup only ever exists next to the file it was made from, so
 * this is one `stat` each and it pairs every backup with its recording.
 */
export async function listOriginalBackups(audioFiles) {
  const found = [];
  for (const recording of audioFiles) {
    if (path.extname(recording).toLowerCase() !== ".m4a") continue;
    const backup = originalBackupFor(recording);
    const stat = await fs.stat(backup).catch(() => null);
    if (stat?.isFile()) found.push({ backup, recording, size: stat.size });
  }
  return found;
}

// --------------------------------------------------------------- atom parsing

const CONTAINER_ATOMS = new Set(["moov", "trak", "mdia", "minf", "stbl", "udta", "edts"]);

/** Walks atoms in [start, end), tolerating declared sizes that run past EOF. */
function walkAtoms(buf, start, end) {
  const out = [];
  let off = start;
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off);
    let body = off + 8;
    if (size === 0) size = end - off; // "extends to EOF"
    else if (size === 1) {
      size = Number(buf.readBigUInt64BE(off + 8));
      body = off + 16;
    }
    if (size < 8) break;
    const type = buf.toString("latin1", off + 4, off + 8);
    out.push({ type, start: off, body, end: off + size, truncated: off + size > buf.length });
    off += size;
  }
  return out;
}

/** Recursive lookup by path, e.g. findAtom(buf, "moov/trak/mdia/minf/stbl/stsz"). */
function findAtom(buf, atomPath) {
  const parts = atomPath.split("/");
  let atoms = walkAtoms(buf, 0, buf.length);
  let hit = null;
  for (const part of parts) {
    hit = atoms.find((a) => a.type === part) ?? null;
    if (!hit) return null;
    const childStart = hit.body + (part === "meta" ? 4 : 0); // meta is a full-box
    if (CONTAINER_ATOMS.has(part) || part === "meta") {
      atoms = walkAtoms(buf, childStart, Math.min(hit.end, buf.length));
    }
  }
  return hit;
}

// Samsung's Voice Recorder writes several vendor-private atoms into `udta`
// that no other MP4 muxer produces - `smta` in particular ("Samsung meta") -
// plus an `ilst` metadata key naming its own package
// ("com.samsung.android.utc_offset"). Both sit early in `moov`, ahead of
// `stsz`, so they survive exactly the kind of end-of-file truncation that
// breaks the index - which makes them a reliable "is this actually a Samsung
// recording" signal even on a file broken badly enough that the rest of the
// index is gone.
const SAMSUNG_UDTA_ATOMS = new Set(["smta", "vrdt", "metd", "SDLN", "smrd", "ampl"]);

/** Whether `buf` carries any of Samsung Voice Recorder's vendor-private metadata. */
export function isSamsungVoiceRecording(buf) {
  const udta = findAtom(buf, "moov/udta");
  if (udta) {
    const children = walkAtoms(buf, udta.body, Math.min(udta.end, buf.length));
    if (children.some((a) => SAMSUNG_UDTA_ATOMS.has(a.type))) return true;
  }
  // Looser fallback for a cut deep enough to take `udta` itself: the ilst
  // encoder-package tag tends to sit further into `moov`, so a truncation
  // that spares it but not `udta` is possible on some files.
  return buf.includes("com.samsung.android", 0, "latin1");
}

/**
 * Whether the file's top-level atom chain runs past the end of the file - the
 * cheap, decode-free signal that this failure shape is present.
 *
 * This exists because a successful ffprobe is *not* evidence the file is fine.
 * Duration lives in `mvhd`/`mdhd`, which sit at the front of `moov` and survive
 * the cut, so ffprobe happily reports the full 27.7s of a recording it cannot
 * decode a single second of. Without this check the repair would only ever be
 * triggered by a failed transcription, leaving browser playback broken for
 * anyone who never transcribes the file.
 *
 * Reads a handful of 16-byte headers rather than the file, so it's cheap enough
 * to run on any .m4a whose duration isn't already cached.
 */
export async function isTruncatedMp4(filePath) {
  let handle = null;
  try {
    handle = await open(filePath, "r");
    const { size } = await handle.stat();
    const header = Buffer.alloc(16);
    let off = 0;
    while (off + 8 <= size) {
      const { bytesRead } = await handle.read(header, 0, 16, off);
      if (bytesRead < 8) break;
      let boxSize = header.readUInt32BE(0);
      let headerLen = 8;
      if (boxSize === 0) break; // "extends to EOF" - can't overrun by definition
      if (boxSize === 1) {
        if (bytesRead < 16) break;
        boxSize = Number(header.readBigUInt64BE(8));
        headerLen = 16;
      }
      if (boxSize < headerLen) break; // malformed in some other way; not our shape
      if (off + boxSize > size) return true;
      off += boxSize;
    }
    return false;
  } catch {
    return false; // unreadable is someone else's error to report
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Repairs `filePath` in place if - and only if - it's one of these damaged
 * recordings. Returns whether the file on disk was replaced.
 *
 * This is the entry point the note model calls for every file it builds, which
 * is what makes the repair reliable rather than incidental. It can't hang off a
 * failed ffprobe (see `isTruncatedMp4` for why a probe succeeds on these), and
 * it can't hang off a cache miss either: a library scanned before this existed
 * has durations cached, so those files would never be looked at again. The
 * check is a few header reads on `.m4a` files only; the repair behind it runs
 * on the rare file that actually needs one.
 */
export async function healIfDamaged(filePath, { onOutput } = {}) {
  if (path.extname(filePath).toLowerCase() !== ".m4a") return false;
  if (!(await isTruncatedMp4(filePath))) return false;
  return Boolean(await repairSamsungM4A(filePath, { onOutput }));
}

/** Pulls the AudioSpecificConfig (descriptor tag 0x05) out of an esds blob. */
function extractASC(buf, stsd) {
  const region = buf.subarray(stsd.body, Math.min(stsd.end, buf.length));
  const i = region.indexOf("esds", 0, "latin1");
  if (i < 0) throw new Error("no esds atom found in stsd");

  let p = i + 4 + 4; // skip 'esds' + version/flags
  while (p < region.length) {
    const tag = region[p++];
    let len = 0;
    let b;
    do {
      b = region[p++];
      len = (len << 7) | (b & 0x7f);
    } while (b & 0x80);

    if (tag === 0x05) return region.subarray(p, p + len);
    if (tag === 0x03) p += 3; // ES descriptor container
    else if (tag === 0x04) p += 13; // DecoderConfig container
    else p += len;
  }
  throw new Error("no DecoderSpecificInfo (tag 0x05) inside esds");
}

const ASC_SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

function parseASC(asc) {
  const bits = (asc[0] << 8) | asc[1];
  return {
    objectType: bits >> 11,
    sampleRate: ASC_SAMPLE_RATES[(bits >> 7) & 0x0f] ?? 48000,
    channels: (bits >> 3) & 0x0f,
  };
}

/**
 * How many audio frames the recording had, read from `stts` - the table that
 * survives the truncation, and the reason this repair can be *verified* rather
 * than trusted. Falls back to `stsz`'s declared count (its header survives even
 * when its entries don't), then null when neither is readable.
 */
function expectedFrameCount(buf) {
  const stts = findAtom(buf, "moov/trak/mdia/minf/stbl/stts");
  if (stts && !stts.truncated) {
    const entries = buf.readUInt32BE(stts.body + 4);
    let total = 0;
    for (let i = 0; i < entries; i++) {
      const at = stts.body + 8 + i * 8;
      if (at + 8 > buf.length) return null;
      total += buf.readUInt32BE(at);
    }
    if (total > 0) return total;
  }
  const stsz = findAtom(buf, "moov/trak/mdia/minf/stbl/stsz");
  if (stsz && stsz.body + 12 <= buf.length) {
    const count = buf.readUInt32BE(stsz.body + 8);
    if (count > 0) return count;
  }
  return null;
}

// ------------------------------------------------------------- MP4 muxing

function box(type, ...parts) {
  const len = parts.reduce((n, p) => n + p.length, 8);
  const out = Buffer.alloc(len);
  out.writeUInt32BE(len, 0);
  out.write(type, 4, "latin1");
  let o = 8;
  for (const p of parts) {
    p.copy(out, o);
    o += p.length;
  }
  return out;
}

function u32(...vals) {
  const out = Buffer.alloc(vals.length * 4);
  vals.forEach((v, i) => out.writeUInt32BE(v >>> 0, i * 4));
  return out;
}

function u16(...vals) {
  const out = Buffer.alloc(vals.length * 2);
  vals.forEach((v, i) => out.writeUInt16BE(v & 0xffff, i * 2));
  return out;
}

/** MPEG-4 descriptor, with the spec's 7-bits-per-byte variable length. */
function descriptor(tag, payload) {
  const lengthBytes = [];
  let n = payload.length;
  do {
    lengthBytes.unshift(n & 0x7f);
    n >>= 7;
  } while (n);
  for (let i = 0; i < lengthBytes.length - 1; i++) lengthBytes[i] |= 0x80;
  return Buffer.concat([Buffer.from([tag]), Buffer.from(lengthBytes), payload]);
}

const IDENTITY_MATRIX = u32(0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000);

const SAMPLES_PER_FRAME = 1024;

/**
 * A minimal, valid .m4a wrapping `audio` as a *single* sample.
 *
 * That single-sample framing is the whole trick (see the module comment): it's
 * deliberately not a truthful index - the blob holds thousands of AAC frames,
 * not one - but it's the shape that gets ffmpeg's decoder to walk the frames
 * itself and hand back where they actually are. `durationTicks` therefore
 * describes the recording as a whole, not the one declared sample; ffmpeg
 * decodes past a short declared duration regardless, but making it right keeps
 * the intermediate self-describing.
 */
function buildSingleSampleM4A(audio, asc, sampleRate, channels, durationTicks) {
  const movieTimescale = 1000;
  const movieDuration = Math.round((durationTicks / sampleRate) * movieTimescale);
  const avgBitrate = 128000;

  const esds = box(
    "esds",
    u32(0),
    descriptor(
      0x03,
      Buffer.concat([
        Buffer.from([0x00, 0x01, 0x00]), // ES_ID, flags
        descriptor(
          0x04,
          Buffer.concat([
            // objectTypeIndication 0x40 (MPEG-4 audio), streamType 0x15 (audio),
            // then the buffer size the decoder should expect.
            Buffer.from([0x40, 0x15, (audio.length >> 16) & 0xff, (audio.length >> 8) & 0xff, audio.length & 0xff]),
            u32(avgBitrate, avgBitrate),
            descriptor(0x05, asc),
          ])
        ),
        descriptor(0x06, Buffer.from([0x02])), // SLConfig: MP4
      ])
    )
  );

  const mp4a = box(
    "mp4a",
    Buffer.alloc(6),
    u16(1), // reserved, data_reference_index
    u32(0, 0), // version/revision/vendor
    u16(channels, 16, 0, 0),
    u32(sampleRate << 16), // 16.16 fixed point
    esds
  );

  const stbl = box(
    "stbl",
    box("stsd", u32(0, 1), mp4a),
    box("stts", u32(0, 1, 1, SAMPLES_PER_FRAME)),
    box("stsc", u32(0, 1, 1, 1, 1)),
    box("stsz", u32(0, 0, 1), u32(audio.length)),
    box("stco", u32(0, 1, 0)) // offset patched in below
  );

  const moov = box(
    "moov",
    box(
      "mvhd",
      u32(0, 0, 0, movieTimescale, movieDuration, 0x00010000),
      u16(0x0100, 0),
      u32(0, 0),
      IDENTITY_MATRIX,
      u32(0, 0, 0, 0, 0, 0),
      u32(2)
    ),
    box(
      "trak",
      box("tkhd", u32(0x00000007, 0, 0, 1, 0, movieDuration), u32(0, 0), u16(0, 0, 0x0100, 0), IDENTITY_MATRIX, u32(0, 0)),
      box(
        "mdia",
        box("mdhd", u32(0, 0, 0, sampleRate, durationTicks), u16(0x55c4, 0)),
        box("hdlr", u32(0), Buffer.alloc(4), Buffer.from("soun", "latin1"), u32(0, 0, 0), Buffer.from("SoundHandler\0", "latin1")),
        box(
          "minf",
          box("smhd", u32(0), u16(0, 0)),
          box("dinf", box("dref", u32(0, 1), box("url ", u32(1)))),
          stbl
        )
      )
    )
  );

  const ftyp = box("ftyp", Buffer.from("M4A \0\0\0\0M4A mp42isom", "latin1"));

  // mdat's payload starts 8 bytes after its header, which follows ftyp+moov.
  const mdatOffset = ftyp.length + moov.length + 8;
  moov.writeUInt32BE(mdatOffset, moov.length - 4); // stco's single entry

  return Buffer.concat([ftyp, moov, box("mdat", audio)]);
}

// ------------------------------------------------------------------ driver

function log(message, onOutput) {
  if (onOutput) onOutput(message);
}

async function probeDurationOf(ffprobe, file) {
  const { stdout } = await execFileAsync(
    ffprobe,
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file],
    { windowsHide: true }
  );
  const value = parseFloat(stdout.trim());
  return Number.isFinite(value) ? value : null;
}

/**
 * Attempts to rebuild a Samsung recorder .m4a whose index (`moov`) was
 * truncated - see the module comment for the mechanism and why ffmpeg, not a
 * byte-level scan, is what finds the frame boundaries. Call this only after
 * ffmpeg/ffprobe has already failed on `filePath`; it's not a speculative
 * check.
 *
 * On success the recording at `filePath` *is* the repaired one - the damaged
 * file is kept aside as `<name>.original.m4a` - and `filePath` is returned.
 * Returns `null` if the file doesn't match this shape or nothing could be
 * recovered. Never throws - a failure just means "keep doing what you were
 * already doing with the original file/error".
 */
export async function repairSamsungM4A(filePath, { onOutput } = {}) {
  const name = path.basename(filePath);
  const backupPath = originalBackupFor(filePath);
  // Staged beside the target rather than in the OS temp dir so the final swap
  // is a rename on one filesystem instead of a whole-file copy across two. The
  // extension is deliberately not an audio one, so a crash between here and the
  // swap leaves something inert rather than a phantom note.
  const stagedPath = `${filePath}.vno-repair.tmp`;
  let intermediate = null;
  let staged = null;

  try {
    // A backup already existing means this file has been through the repair:
    // `filePath` is the rebuilt recording and `backupPath` is the one pristine
    // copy of the damaged original. Redoing it would overwrite that copy with
    // an already-repaired file and destroy the only thing left to re-examine.
    if (await fs.pathExists(backupPath)) {
      log(`${name} is already repaired (original kept as ${path.basename(backupPath)})`, onOutput);
      return filePath;
    }

    const buf = await fs.readFile(filePath);

    // Gate on the vendor markers before doing any of the work below - this is
    // a Samsung-specific exception, not a generic "any m4a with a broken
    // index" fixer, so a non-Samsung file with an unrelated corruption should
    // fall through to its original error.
    if (!isSamsungVoiceRecording(buf)) throw new Error("no Samsung Voice Recorder markers found - not this special case");

    const mdat = findAtom(buf, "mdat");
    if (!mdat) throw new Error("no mdat atom - not a recoverable MP4/m4a");
    if (!findAtom(buf, "moov")) throw new Error("no moov atom at all - nothing to read the codec config from");
    // A truncated mdat means the audio itself is short, not just the index.
    // Everything after the cut is genuinely absent, so there's nothing here to
    // recover that ffmpeg couldn't already have read.
    if (mdat.truncated) throw new Error("mdat itself is truncated - audio is incomplete, not just the index");

    const stsd = findAtom(buf, "moov/trak/mdia/minf/stbl/stsd");
    if (!stsd) throw new Error("stsd missing - codec config is unrecoverable");
    const asc = extractASC(buf, stsd);
    const { sampleRate, channels } = parseASC(asc);

    const ffmpeg = (await which("ffmpeg")) || "ffmpeg";
    const ffprobe = (await which("ffprobe")) || "ffprobe";

    const audio = buf.subarray(mdat.body, Math.min(mdat.end, buf.length));
    if (!audio.length) throw new Error("mdat is empty - no audio to recover");

    const frames = expectedFrameCount(buf);
    const expectedSeconds = frames ? (frames * SAMPLES_PER_FRAME) / sampleRate : null;

    // Declared duration for the intermediate. When stts is unreadable there's
    // nothing to state honestly, so overstate it - ffmpeg decodes to the end of
    // the buffer either way, and an over-long declaration can't truncate what
    // gets recovered the way an under-long one might.
    const durationTicks = frames ? frames * SAMPLES_PER_FRAME : audio.length * SAMPLES_PER_FRAME;

    intermediate = path.join(os.tmpdir(), `vno-repair-${process.pid}-${Date.now()}.m4a`);
    await fs.writeFile(intermediate, buildSingleSampleM4A(audio, asc, sampleRate, channels || 1, durationTicks));

    // Re-encode rather than copy: only the decoder knows where the recovered
    // frames start, so there are no frame boundaries to copy along. `+faststart`
    // puts the rebuilt index at the *front* of the repaired file, so the copy
    // can't fail the same way the original did if it's ever interrupted mid-sync.
    const args = ["-y", "-v", "error", "-i", intermediate, "-c:a", "aac"];
    if (expectedSeconds) {
      const bitrate = Math.min(320000, Math.max(32000, Math.round((audio.length * 8) / expectedSeconds)));
      args.push("-b:a", String(bitrate));
    }
    // `-f mp4` because the staged name ends in `.tmp`: ffmpeg picks the muxer
    // from the output extension and refuses outright when it doesn't know one.
    args.push("-movflags", "+faststart", "-f", "mp4", stagedPath);

    staged = stagedPath;
    try {
      await execFileAsync(ffmpeg, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    } catch (err) {
      throw new Error(`ffmpeg couldn't re-frame the recovered audio: ${lastLine(err.stderr || err.message)}`);
    }

    // Verification, and the reason this is a deterministic repair rather than a
    // hopeful one: `stts` recorded how long the recording was before the file
    // was cut, so a rebuild of that length means every frame came back. It runs
    // *before* anything is renamed, so a repair that can't be vouched for never
    // gets to touch the user's file.
    const actual = await probeDurationOf(ffprobe, stagedPath).catch(() => null);
    if (actual == null) throw new Error("the rebuilt audio still doesn't probe - repair failed");
    const shortfall = expectedSeconds && Math.abs(actual - expectedSeconds) > 0.25;

    // Swap, original first: after this rename the damaged file is safe under its
    // own name, so the only window where the recording isn't at `filePath` is the
    // rename that immediately follows - and if that fails, it's put straight back.
    await fs.move(filePath, backupPath);
    try {
      await fs.move(stagedPath, filePath);
    } catch (err) {
      await fs.move(backupPath, filePath).catch(() => {});
      throw new Error(`couldn't put the repaired audio in place: ${err.message}`);
    }
    staged = null;

    log(
      shortfall
        ? `Repaired ${name}, but recovered ${actual.toFixed(1)}s of an expected ${expectedSeconds.toFixed(1)}s - ` +
            `some frames were unreadable. Damaged original kept as ${path.basename(backupPath)}`
        : `Repaired ${name}: recovered ${actual.toFixed(1)}s` +
            (frames ? `, all ${frames} frames` : "") +
            `. Damaged original kept as ${path.basename(backupPath)}`,
      onOutput
    );
    return filePath;
  } catch (err) {
    log(`Samsung m4a repair skipped for ${name}: ${err.message}`, onOutput);
    return null;
  } finally {
    if (intermediate) await fs.remove(intermediate).catch(() => {});
    if (staged) await fs.remove(staged).catch(() => {});
  }
}

/** The useful line of a child process failure - ffmpeg pads its errors with blanks. */
function lastLine(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines[lines.length - 1] || "no output";
}
