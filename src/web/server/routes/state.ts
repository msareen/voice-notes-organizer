import type { ServerContext } from "../context.ts";

/** GET /api/state, POST /api/ping, POST /api/bye. */
export function createStateRoutes(ctx: ServerContext) {
  async function state(): Promise<Response> {
    return ctx.sendJson(200, await ctx.stateResponse());
  }

  function ping(): Response {
    return new Response(null, { status: 204 });
  }

  function bye(body: { quit?: boolean }): Response {
    // The Quit button means it: stop now. A pagehide beacon only nudges the
    // normal deferred shutdown, so a reload or a sibling tab is safe.
    if (body.quit) setTimeout(() => ctx.stop("quit from the browser"), 200);
    else ctx.scheduleShutdown("browser closed", 2500);
    return new Response(null, { status: 204 });
  }

  /** POST /api/job/cancel - kills whatever the running job's current spawn is. */
  function cancelJob(): Response {
    const cancelled = ctx.cancelJob();
    if (!cancelled) return ctx.sendJson(409, { error: "No job is running" });
    return new Response(null, { status: 204 });
  }

  return { state, ping, bye, cancelJob };
}
