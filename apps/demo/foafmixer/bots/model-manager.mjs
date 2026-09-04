#!/usr/bin/env node
// Starts/stops the llama-server backends on demand and stops them again
// after they've been idle, instead of leaving both loaded (and holding
// RAM) all the time. macOS already reclaims most of an idle llama-server's
// mmap'd model-weight pages on its own (verified empirically -- an idle
// 13B model's RSS drops to ~1MB), but that's opportunistic and only
// happens under real memory pressure; actually stopping the process is
// the only way to free RAM on our own schedule.
//
// Exposes a tiny local HTTP control API:
//   POST /touch/:name   record activity; start the backend if it isn't
//                       running (does NOT wait for it to be ready --
//                       fire-and-forget pre-warming, e.g. on any channel
//                       message even if this bot won't reply to it)
//   POST /ensure/:name  like /touch, but waits until the backend is
//                       actually healthy before responding (use this right
//                       before querying it)
//   GET  /status         JSON: state of every backend
//
// Run this before the bots; they call it instead of assuming llama-server
// is already up.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

const MANAGER_PORT = Number(process.env.MODEL_MANAGER_PORT || '8199');
const IDLE_TIMEOUT_MS = Number(process.env.MODEL_IDLE_TIMEOUT_MS || 10 * 60 * 1000); // 10 min
const REAP_INTERVAL_MS = 30000;
const bot_dir = '/Users/danbri/working/sandbox/mix/foafmixer-mix/apps/demo/foafmixer/bots';

const BACKENDS = {
  // 13B, CPU-only (Metal produces NaN output for this model -- see repo
  // notes). Cold-load time varies a lot with system load and whether the
  // model file is still in the OS page cache -- seen anywhere from ~20s to
  // 2+ minutes, so it gets a generous startup allowance.
  talkie: {
    port: 8188,
    startTimeoutMs: 180000,
    // Cold-start is slow and unpredictable (20s-150s+ seen). macOS already
    // reclaims an idle process's mmap'd model-weight pages on its own --
    // observed RSS dropping to ~1MB with the process still alive and
    // ready to page back in fast. Actively killing it trades that
    // near-free automatic reclaim for a forced full reinit, so give it a
    // much longer leash than Qwen.
    idleTimeoutMs: 2 * 60 * 60 * 1000, // 2h
    args: [
      '-m', `${bot_dir}/models/talkie-1930-13b-it-hf.i1-Q4_K_S.gguf`,
      '--host', '127.0.0.1', '--port', '8188', '-c', '2048', '-ngl', '0',
    ],
  },
  // 4B, Metal-accelerated. Cold-loads in a few seconds.
  qwen: {
    port: 8189,
    startTimeoutMs: 30000,
    args: [
      '-m', `${bot_dir}/models/Qwen3-4B-Instruct-2507-Q4_K_M.gguf`,
      '--host', '127.0.0.1', '--port', '8189', '-c', '4096',
    ],
  },
};

for (const [name, backend] of Object.entries(BACKENDS)) {
  backend.name = name;
  backend.proc = null;
  backend.state = 'stopped'; // stopped | starting | running
  backend.lastActivity = 0;
  backend.startingPromise = null;
}

async function isHealthy(backend) {
  try {
    const resp = await fetch(`http://127.0.0.1:${backend.port}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

async function waitHealthy(backend, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isHealthy(backend)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function startBackend(backend) {
  if (backend.startingPromise) return backend.startingPromise;
  backend.state = 'starting';
  console.log(`[model-manager] starting ${backend.name} on :${backend.port}`);
  const logPath = `${bot_dir}/${backend.name}-server.log`;
  const proc = spawn('llama-server', backend.args, {
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true,
  });
  backend.proc = proc;
  proc.unref();
  proc.on('exit', (code) => {
    console.log(`[model-manager] ${backend.name} exited (code ${code})`);
    if (backend.proc === proc) {
      backend.proc = null;
      backend.state = 'stopped';
    }
  });

  backend.startingPromise = waitHealthy(backend, backend.startTimeoutMs).then((ok) => {
    backend.startingPromise = null;
    if (ok) {
      backend.state = 'running';
      console.log(`[model-manager] ${backend.name} ready`);
    } else {
      // Gave up waiting -- kill it rather than leaving an untracked
      // process bound to the port (a later start attempt would otherwise
      // collide with it, or just silently start a redundant second copy).
      console.log(`[model-manager] ${backend.name} FAILED to become healthy in ${backend.startTimeoutMs}ms, killing it`);
      stopBackend(backend);
    }
    return ok;
  });
  return backend.startingPromise;
}

function stopBackend(backend) {
  if (!backend.proc) return;
  console.log(`[model-manager] stopping ${backend.name} (idle ${Math.round((Date.now() - backend.lastActivity) / 1000)}s)`);
  try { process.kill(-backend.proc.pid, 'SIGTERM'); } catch { try { backend.proc.kill('SIGTERM'); } catch {} }
  backend.proc = null;
  backend.state = 'stopped';
}

setInterval(() => {
  const now = Date.now();
  for (const backend of Object.values(BACKENDS)) {
    const timeout = backend.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    if (backend.state === 'running' && now - backend.lastActivity > timeout) {
      stopBackend(backend);
    }
  }
}, REAP_INTERVAL_MS);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);

  if (req.method === 'GET' && parts[0] === 'status') {
    const status = {};
    for (const [name, backend] of Object.entries(BACKENDS)) {
      status[name] = {
        state: backend.state,
        idleSeconds: backend.lastActivity ? Math.round((Date.now() - backend.lastActivity) / 1000) : null,
      };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status, null, 2));
    return;
  }

  if (req.method === 'POST' && (parts[0] === 'touch' || parts[0] === 'ensure')) {
    const backend = BACKENDS[parts[1]];
    if (!backend) { res.writeHead(404); res.end('unknown backend'); return; }
    backend.lastActivity = Date.now();
    if (backend.state === 'stopped') startBackend(backend);

    if (parts[0] === 'ensure') {
      const ok = backend.state === 'running' || await (backend.startingPromise ?? Promise.resolve(false));
      res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ready: ok, state: backend.state }));
      return;
    }
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ state: backend.state }));
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

server.listen(MANAGER_PORT, '127.0.0.1', () => {
  console.log(`[model-manager] listening on 127.0.0.1:${MANAGER_PORT}, idle timeout ${IDLE_TIMEOUT_MS / 1000}s`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    for (const backend of Object.values(BACKENDS)) stopBackend(backend);
    process.exit(0);
  });
}
