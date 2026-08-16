/** GET /api/state, POST /api/ping, POST /api/bye. */
export function createStateRoutes(ctx) {
  async function state(res) {
    ctx.sendJson(res, 200, await ctx.stateResponse());
  }

  function ping(res) {
    res.writeHead(204);
    res.end();
  }

  function bye(res, body) {
    res.writeHead(204);
    res.end();
    // The Quit button means it: stop now. A pagehide beacon only nudges the
    // normal deferred shutdown, so a reload or a sibling tab is safe.
    if (body.quit) setTimeout(() => ctx.stop("quit from the browser"), 200);
    else ctx.scheduleShutdown("browser closed", 2500);
  }

  return { state, ping, bye };
}
