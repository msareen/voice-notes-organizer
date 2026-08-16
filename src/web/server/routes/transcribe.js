import path from "node:path";
import chalk from "chalk";
import { transcribeFile, resolveAccel, accelState, accelUnasked, isDeviceError, lastLine } from "../../../lib/whisper.js";
import { MODELS } from "../constants.js";

/**
 * One job's whisper runs, sharing the device decision across its files.
 *
 * The page has nowhere to ask at job time, so an accelerator the user was
 * never asked about is used and announced rather than left idle - the
 * Settings dialog is where they turn it off. A run that fails on the
 * accelerator downgrades the rest of the job to the CPU; there's nothing to
 * forget in config, since the backend is fixed by which binary is installed
 * and re-checking it is free (unlike the old torch probe).
 *
 * Shared with the import route, whose optional post-import translate pass
 * reuses the exact same fallback behaviour.
 */
export function createWhisperRunner(ctx) {
  return function whisperRunner({ model, translate }) {
    let device = resolveAccel(ctx.config);
    const language = ctx.config.transcribeLanguage || "auto";
    if (device !== "cpu") {
      const accel = accelState(ctx.config);
      ctx.jobLog(`Using accelerated transcription${accel.name ? ` (${accel.name})` : ""}.`);
      if (accelUnasked(ctx.config)) ctx.jobLog("Turn this off in Settings if you'd rather stay on the CPU.");
    }

    return async function run(file) {
      try {
        await transcribeFile(file, { model, translate, device, language, onOutput: (line) => ctx.jobLog(line) });
        return;
      } catch (err) {
        if (device === "cpu" || !isDeviceError(err.message)) throw err;
        ctx.jobLog(`Accelerator run failed: ${lastLine(err.message)}`);
        ctx.jobLog("Falling back to the CPU for the rest of this job.");
        device = "cpu";
      }
      await transcribeFile(file, { model, translate, device: "cpu", language, onOutput: (line) => ctx.jobLog(line) });
    };
  };
}

/** POST /api/transcribe. */
export function createTranscribeRoutes(ctx) {
  const whisperRunner = createWhisperRunner(ctx);

  async function transcribe(res, body) {
    if (ctx.guardJob(res)) return;
    // The browser can't run an installer, so the page points at the CLI, which
    // can: `vno setup` offers the install for whichever half is missing.
    const deps = await ctx.dependencyStatus();
    if (!deps.whisper || !deps.ffmpeg) {
      const missing = [!deps.ffmpeg && "ffmpeg", !deps.whisper && "whisper"].filter(Boolean);
      return ctx.sendJson(res, 412, {
        error: `${missing.join(" and ")} ${missing.length > 1 ? "aren't" : "isn't"} on your PATH. Run \`vno setup\` in a terminal to install ${missing.length > 1 ? "them" : "it"}.`,
      });
    }

    const rels = (Array.isArray(body.rels) ? body.rels : []).filter((rel) => ctx.noteFor(rel));
    if (rels.length === 0) return ctx.sendJson(res, 400, { error: "No valid files selected" });

    const model = MODELS.includes(body.model) ? body.model : ctx.config.defaultModel || "turbo";
    const translate = Boolean(body.translate);

    ctx.startJob("transcribe", `${translate ? "Translating" : "Transcribing"} ${rels.length} file(s)`, rels.length);
    ctx.sendJson(res, 202, { started: true });

    (async () => {
      const verb = translate ? "Translating" : "Transcribing";
      const runWhisper = whisperRunner({ model, translate });
      let done = 0;
      for (const rel of rels) {
        const full = ctx.resolveInside(rel);
        ctx.jobProgress(done, `${verb} ${path.basename(rel)} (${done + 1}/${rels.length})`);
        ctx.jobLog(`[${done + 1}/${rels.length}] ${verb} ${rel}`);
        console.log(chalk.cyan(`\n[${done + 1}/${rels.length}] ${verb} ${rel} (from the browser)...`));
        try {
          await runWhisper(full);
          done++;
          const savedTo = rel.replace(/\.[^.]+$/, ".vtt");
          ctx.jobLog(`Saved ${savedTo}`);
          console.log(chalk.green(`Saved -> ${savedTo}`));
        } catch (err) {
          ctx.jobLog(`FAILED ${rel}: ${err.message}`);
          console.log(chalk.red(`Failed to transcribe ${rel}: ${err.message}`));
        }
        ctx.jobProgress(done);
      }
      const summary = `${translate ? "Translated" : "Transcribed"} ${done}/${rels.length} file(s)`;
      ctx.jobProgress(done, summary);
      console.log(chalk.cyan(summary));
      await ctx.endJob(null);
    })().catch((err) => ctx.endJob(err));
  }

  return { transcribe };
}
