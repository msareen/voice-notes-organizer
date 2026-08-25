import path from "node:path";
import fs from "fs-extra";
import chalk from "chalk";
import { summarizeText, resolveLlamaAccel, llamaAccelState, llamaAccelUnasked, isDeviceError, lastLine } from "../../../lib/llama/llama.ts";
import { readSummary, writeSummary, findSummary } from "../../../lib/notes/notes.ts";
import type { ServerContext } from "../context.ts";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface LlamaRunOptions {
  model: string;
}

/** Runs llama.cpp over one transcript, with this job's shared device decision. */
export type LlamaRun = (text: string) => Promise<string>;

/**
 * One job's llama.cpp run, sharing the device decision the way
 * `createWhisperRunner` does for transcription. A summarize job only ever
 * has one file (per vno's locked single-recording scope), so the "rest of
 * this job" fallback is nearly vestigial here - kept anyway for consistency
 * with the transcribe path rather than special-cased away.
 */
export function createLlamaRunner(ctx: ServerContext) {
  return function llamaRunner({ model }: LlamaRunOptions): LlamaRun {
    let device: string = resolveLlamaAccel(ctx.config);
    if (device !== "cpu") {
      const accel = llamaAccelState(ctx.config);
      ctx.jobLog(`Using accelerated summarization${accel.name ? ` (${accel.name})` : ""}.`);
      if (llamaAccelUnasked(ctx.config)) ctx.jobLog("Turn this off in Settings if you'd rather stay on the CPU.");
    }

    return async function run(text: string): Promise<string> {
      const prompt = ctx.config.summaryPrompt;
      const llamaCliPath = ctx.config.llamaCliPath;
      try {
        return await summarizeText(text, { model, device, prompt, llamaCliPath, onOutput: (line) => ctx.jobLog(line) });
      } catch (err) {
        if (device === "cpu" || !isDeviceError(errorMessage(err))) throw err;
        ctx.jobLog(`Accelerator run failed: ${lastLine(errorMessage(err))}`);
        ctx.jobLog("Falling back to the CPU.");
        device = "cpu";
      }
      return summarizeText(text, { model, device: "cpu", prompt, llamaCliPath, onOutput: (line) => ctx.jobLog(line) });
    };
  };
}

interface SummarizeBody {
  rel?: unknown;
  model?: string;
}

interface SummaryBody {
  rel?: unknown;
  text?: unknown;
}

/** POST /api/summarize, PUT /api/summary. */
export function createSummarizeRoutes(ctx: ServerContext) {
  const llamaRunner = createLlamaRunner(ctx);

  async function summarize(body: SummarizeBody): Promise<Response> {
    const busy = ctx.guardJob();
    if (busy) return busy;

    if (typeof body.rel !== "string") return ctx.sendJson(400, { error: "Expected a single `rel`" });
    const rel = body.rel;

    // Summarization is optional - unlike transcribe's ffmpeg/whisper 412,
    // this is the only route in vno that can be entirely unavailable on a
    // machine that never opted in, so the message points at the opt-in flag
    // rather than the always-required `vno setup`.
    const status = await ctx.summarizationStatus();
    if (!status.available) {
      return ctx.sendJson(412, {
        error: "Summarization isn't set up. Run `vno setup --llama` in a terminal to add it.",
      });
    }

    const note = ctx.noteFor(rel);
    if (!note) return ctx.sendJson(404, { error: "Unknown note" });
    if (!note.hasTranscript) return ctx.sendJson(400, { error: "Transcribe this recording first" });

    const model = body.model && status.models.includes(body.model) ? body.model : ctx.config.summaryModel;
    if (!model || !status.models.includes(model)) {
      return ctx.sendJson(400, { error: "No summarization model selected. Pick one in Settings." });
    }

    const full = ctx.resolveInside(rel);
    if (!full) return ctx.sendJson(400, { error: "Path outside the target folder" });

    ctx.startJob("summarize", `Summarizing ${path.basename(rel)}`, 1);

    (async () => {
      ctx.jobLog(`Summarizing ${rel}`);
      console.log(chalk.cyan(`\nSummarizing ${rel} (from the browser)...`));
      try {
        const run = llamaRunner({ model });
        const summary = await run(note.text);
        await writeSummary(full, summary);
        const savedTo = rel.replace(/\.[^.]+$/, ".summary.txt");
        ctx.jobProgress(1, `Summarized ${path.basename(rel)}`);
        ctx.jobLog(`Saved ${savedTo}`);
        console.log(chalk.green(`Saved -> ${savedTo}`));
      } catch (err) {
        ctx.jobLog(`FAILED ${rel}: ${errorMessage(err)}`);
        console.log(chalk.red(`Failed to summarize ${rel}: ${errorMessage(err)}`));
        await ctx.endJob(err);
        return;
      }
      await ctx.endJob(null);
    })().catch((err) => ctx.endJob(err));

    return ctx.sendJson(202, { started: true });
  }

  /** Manual edit of a generated summary - no cue-count concerns, summaries carry no timing data. */
  async function saveSummary(body: SummaryBody): Promise<Response> {
    if (typeof body.rel !== "string") return ctx.sendJson(400, { error: "Expected `rel`" });
    const note = ctx.noteFor(body.rel);
    if (!note) return ctx.sendJson(404, { error: "Unknown note" });
    const full = ctx.resolveInside(body.rel);
    if (!full) return ctx.sendJson(400, { error: "Path outside the target folder" });

    const text = String(body.text ?? "").trim();
    if (!text) {
      const existing = await findSummary(full);
      if (existing) await fs.remove(existing);
    } else {
      await writeSummary(full, text);
    }
    Object.assign(note, await readSummary(full));
    ctx.log(`Summary saved from the browser: ${body.rel}`);
    return ctx.sendJson(200, { note });
  }

  return { summarize, saveSummary };
}
