import type { ServerResponse } from "node:http";
import type { ServerContext } from "../context.ts";

/** GET /api/state, POST /api/ping, POST /api/bye. */
export function createStateRoutes(ctx: ServerContext) {
  async function state(res: ServerResponse): Promise<void> {
    ctx.sendJson(res, 200, await ctx.stateResponse());
  }

  function ping(res: ServerResponse): void {
    res.writeHead(204);
    res.end();
  }

  function bye(res: ServerResponse, body: { quit?: boolean }): void {
    res.writeHead(204);
    res.end();
    // The Quit button means it: stop now. A pagehide beacon only nudges the
    // normal deferred shutdown, so a reload or a sibling tab is safe.
    if (body.quit) setTimeout(() => ctx.stop("quit from the browser"), 200);
    else ctx.scheduleShutdown("browser closed", 2500);
  }

  return { state, ping, bye };
}
