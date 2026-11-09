// glibc reads MALLOC_ARENA_MAX once, at process start, so setting it in
// process.env inside the running gateway would only reach its children. The
// gateway's `run` therefore re-execs itself in place (process.execve: same
// pid, no wrapper process, the environment is not copied anywhere else) with
// MALLOC_ARENA_MAX=2 when it is unset. An explicit MALLOC_ARENA_MAX (any
// value) wins and is never re-exec'd, which also stops a loop. Linux only;
// without process.execve (Node < 22.15) the gateway runs as before.
export const GATEWAY_MALLOC_ARENA_MAX = "2";
export function mallocArenaReexecPlan({ env = process.env, platform = process.platform, execve = process.execve, execPath = process.execPath, execArgv = process.execArgv, argv = process.argv } = {}) {
  if (platform !== "linux" || typeof execve !== "function") return undefined;
  if (env.MALLOC_ARENA_MAX !== undefined && env.MALLOC_ARENA_MAX !== "") return undefined;
  return { file: execPath, args: [execPath, ...execArgv, ...argv.slice(1)], env: { ...env, MALLOC_ARENA_MAX: GATEWAY_MALLOC_ARENA_MAX } };
}
// Never returns when it re-execs. Logs only the setting, never the env.
export function ensureGatewayMallocArena(options = {}, log = (line) => console.log(line)) {
  const plan = mallocArenaReexecPlan(options);
  if (!plan) return false;
  log(`gateway: re-exec with MALLOC_ARENA_MAX=${GATEWAY_MALLOC_ARENA_MAX}`);
  (options.execve ?? process.execve)(plan.file, plan.args, plan.env);
  return true;
}
