import http from 'http';
import os from 'os';
import { Worker } from 'node:worker_threads';
import { URL } from 'url';

const DEFAULT_PORT = 9000;
const PORT = Number(process.env.SHOPSCOUT_SEARCH_CORE_PORT || DEFAULT_PORT);
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const FETCH_TIMEOUT_MS = Number(process.env.SHOPSCOUT_SEARCH_CORE_TIMEOUT_MS || 10000);
const PLAYWRIGHT_TIMEOUT_MS = Number(process.env.SHOPSCOUT_SEARCH_CORE_PLAYWRIGHT_TIMEOUT_MS || 15000);
const PLAYWRIGHT_NETWORK_IDLE_WAIT_MS = Number(process.env.SHOPSCOUT_SEARCH_CORE_PLAYWRIGHT_NETWORK_IDLE_MS || 2000);
const PLAYWRIGHT_ENABLED = process.env.SHOPSCOUT_SEARCH_CORE_PLAYWRIGHT === 'false' ? false : true;
const WORKER_COUNT = Number(process.env.SHOPSCOUT_SEARCH_CORE_WORKERS || Math.max(1, Math.min(os.cpus().length, 4)));
const WORKER_PATH = new URL('./search-core-worker.js', import.meta.url);

const defaultResponseHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    ...defaultResponseHeaders,
    'Content-Type': 'application/json'
  });
  res.end(JSON.stringify(payload));
}

function applyDefaultHeaders(res) {
  Object.entries(defaultResponseHeaders).forEach(([key, value]) => {
    res.setHeader(key, value);
  });
}

class WorkerPool {
  constructor(workerPath, size) {
    this.workerPath = workerPath;
    this.size = Math.max(1, size);
    this.queue = [];
    this.idleWorkers = [];
    this.workers = new Set();
    this.tasks = new Map();
    this.nextTaskId = 1;
    this.shuttingDown = false;

    for (let i = 0; i < this.size; i += 1) {
      this.spawnWorker();
    }
  }

  spawnWorker() {
    if (this.shuttingDown) {
      return;
    }

    const worker = new Worker(this.workerPath, { type: 'module' });
    worker.on('message', (message) => this.handleMessage(worker, message));
    worker.on('error', (error) => this.handleWorkerError(worker, error));
    worker.on('exit', (code) => this.handleWorkerExit(worker, code));

    this.workers.add(worker);
    this.idleWorkers.push(worker);
    this.drainQueue();
  }

  runTask(payload) {
    if (this.shuttingDown) {
      return Promise.reject(new Error('Worker pool is shutting down'));
    }

    return new Promise((resolve, reject) => {
      this.queue.push({ payload, resolve, reject });
      this.drainQueue();
    });
  }

  drainQueue() {
    if (this.shuttingDown) {
      return;
    }

    while (this.idleWorkers.length > 0 && this.queue.length > 0) {
      const worker = this.idleWorkers.shift();
      const task = this.queue.shift();
      const id = this.nextTaskId++;

      this.tasks.set(id, { resolve: task.resolve, reject: task.reject, worker });

      try {
        worker.postMessage({ id, payload: task.payload });
      } catch (error) {
        this.tasks.delete(id);
        task.reject(error);
        this.handleWorkerError(worker, error);
      }
    }
  }

  handleMessage(worker, message) {
    if (this.shuttingDown) {
      return;
    }

    if (message && message.command === 'ready') {
      if (!this.idleWorkers.includes(worker)) {
        this.idleWorkers.push(worker);
      }
      this.drainQueue();
      return;
    }

    const { id, success, result, error } = message || {};
    if (typeof id !== 'number') {
      if (!this.idleWorkers.includes(worker)) {
        this.idleWorkers.push(worker);
      }
      this.drainQueue();
      return;
    }

    const task = this.tasks.get(id);
    if (!task) {
      if (!this.idleWorkers.includes(worker)) {
        this.idleWorkers.push(worker);
      }
      this.drainQueue();
      return;
    }

    this.tasks.delete(id);

    if (success) {
      task.resolve(result);
    } else {
      task.reject(new Error(error || 'Worker task failed'));
    }

    if (!this.idleWorkers.includes(worker)) {
      this.idleWorkers.push(worker);
    }
    this.drainQueue();
  }

  handleWorkerError(worker, error) {
    if (this.shuttingDown) {
      return;
    }

    for (const [taskId, task] of this.tasks.entries()) {
      if (task.worker === worker) {
        task.reject(error);
        this.tasks.delete(taskId);
      }
    }

    const idleIndex = this.idleWorkers.indexOf(worker);
    if (idleIndex !== -1) {
      this.idleWorkers.splice(idleIndex, 1);
    }

    this.workers.delete(worker);

    if (!this.shuttingDown) {
      this.spawnWorker();
    }
  }

  handleWorkerExit(worker, code) {
    if (this.shuttingDown) {
      return;
    }

    const error = new Error(`Worker exited with code ${code}`);
    this.handleWorkerError(worker, error);
  }

  async destroy() {
    if (this.shuttingDown) {
      return;
    }

    this.shuttingDown = true;

    const shutdownError = new Error('Worker pool shutting down');
    for (const queuedTask of this.queue.splice(0)) {
      queuedTask.reject(shutdownError);
    }

    for (const [taskId, task] of this.tasks.entries()) {
      task.reject(shutdownError);
      this.tasks.delete(taskId);
    }

    const workers = Array.from(this.workers);
    await Promise.allSettled(workers.map((worker) => {
      try {
        worker.postMessage({ command: 'shutdown' });
      } catch (_) {
        // ignore
      }
      return worker.terminate().catch(() => {});
    }));

    this.workers.clear();
    this.idleWorkers = [];
  }

  forceTerminate() {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;

    const shutdownError = new Error('Worker pool shutting down');
    for (const task of this.queue.splice(0)) {
      task.reject(shutdownError);
    }
    for (const [taskId, task] of this.tasks.entries()) {
      task.reject(shutdownError);
      this.tasks.delete(taskId);
    }

    for (const worker of this.workers) {
      try {
        worker.terminate();
      } catch (_) {
        // ignore
      }
    }

    this.workers.clear();
    this.idleWorkers = [];
  }
}

const workerPool = new WorkerPool(WORKER_PATH, WORKER_COUNT);

const server = http.createServer(async (req, res) => {
  applyDefaultHeaders(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  let requestUrl;
  try {
    requestUrl = new URL(req.url, `http://${req.headers.host}`);
  } catch (error) {
    sendJson(res, 400, { error: 'Invalid request URL.' });
    return;
  }

  if (requestUrl.pathname === '/health') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  if (requestUrl.pathname !== '/fetch') {
    sendJson(res, 404, { error: 'Not found.' });
    return;
  }

  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed. Use GET.' });
    return;
  }

  const target = requestUrl.searchParams.get('url');
  if (!target) {
    sendJson(res, 400, { error: 'Missing url query parameter.' });
    return;
  }

  let upstreamUrl;
  try {
    upstreamUrl = new URL(target);
  } catch (error) {
    sendJson(res, 400, { error: 'Invalid target URL.' });
    return;
  }

  if (!ALLOWED_PROTOCOLS.has(upstreamUrl.protocol)) {
    sendJson(res, 400, { error: 'Only http and https protocols are supported.' });
    return;
  }

  const renderMode = requestUrl.searchParams.get('render');

  try {
    const upstream = await workerPool.runTask({
      type: 'forwardRequest',
      targetUrl: upstreamUrl.toString(),
      renderMode
    });

    const bodyBuffer = upstream?.body
      ? Buffer.isBuffer(upstream.body)
        ? upstream.body
        : Buffer.from(upstream.body)
      : Buffer.alloc(0);

    res.writeHead(
      upstream.status,
      {
        ...defaultResponseHeaders,
        'Content-Type': upstream.contentType,
        'Cache-Control': 'no-store'
      }
    );
    res.end(bodyBuffer);
  } catch (error) {
    if (error.name === 'AbortError') {
      sendJson(res, 504, { error: `Upstream request timed out after ${FETCH_TIMEOUT_MS}ms.` });
      return;
    }
    sendJson(res, 502, { error: `Upstream request failed: ${error.message}` });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[ShopScout Search Core] listening on http://127.0.0.1:${PORT}`);
});

server.on('error', error => {
  console.error('[ShopScout Search Core] Server error:', error);
  process.exitCode = 1;
});

let shutdownInitiated = false;

const shutdown = (signal) => {
  if (shutdownInitiated) {
    if (signal) {
      process.exit(0);
    }
    return;
  }

  shutdownInitiated = true;

  workerPool.destroy()
    .catch((error) => {
      console.warn('[ShopScout Search Core] Worker pool shutdown error:', error?.message || error);
    })
    .finally(() => {
      if (signal) {
        process.exit(0);
      }
    });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => {
  workerPool.forceTerminate();
});
