#!/usr/bin/env node

import { chmod, lstat, unlink } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { acquireMutationLock, connectBrowser } from './bridge.mjs';
import { ensurePrivateDirectory, instancePaths } from './paths.mjs';

export const MAX_IPC_REQUEST_BYTES = 1024 * 1024;

const ARITY = {
  status: [0], tabs: [0], tabsAll: [0], bind: [0, 1], unbind: [0],
  open: [1], activate: [1], navigate: [2], snapshot: [1, 2], text: [1, 2],
  click: [2], fill: [3], press: [3], select: [3], scroll: [2], closeTab: [1], screenshot: [1], shutdown: [0],
};

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function socketIsLive(path) {
  return new Promise((resolve, reject) => {
    const probe = createConnection(path);
    probe.once('connect', () => { probe.destroy(); resolve(true); });
    probe.once('error', error => {
      probe.destroy();
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve(false);
      else reject(error);
    });
  });
}

async function prepareSocket(path) {
  try {
    const stat = await lstat(path);
    if (!stat.isSocket() || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error('Existing browser broker socket has an unexpected owner or type');
    }
    if (await socketIsLive(path)) throw new Error('BROKER_ALREADY_RUNNING');
    await unlink(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export async function startBroker({ paths = instancePaths(), browser } = {}) {
  browser ??= await connectBrowser({ paths });
  await ensurePrivateDirectory(paths.dir);
  const releaseStartLock = await acquireMutationLock(join(paths.dir, 'startup'));
  const connections = new Set();
  let stopping = false;
  let boundIno;
  const server = createServer(socket => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    socket.on('error', () => socket.destroy());
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    void (async () => {
      for await (const line of lines) {
        if (Buffer.byteLength(line) > MAX_IPC_REQUEST_BYTES) {
          socket.write(`${JSON.stringify({ id: null, error: 'IPC_REQUEST_TOO_LARGE' })}\n`);
          continue;
        }
        let request;
        try {
          request = JSON.parse(line);
          if (!request || !Number.isSafeInteger(request.id) || typeof request.method !== 'string' ||
              !Array.isArray(request.args) || !Object.hasOwn(ARITY, request.method) || !ARITY[request.method].includes(request.args.length)) {
            throw new Error('Invalid broker request');
          }
          if (request.method === 'shutdown') {
            socket.write(`${JSON.stringify({ id: request.id, result: { stopping: true } })}\n`);
            setTimeout(() => { void close(); }, 50).unref();
            continue;
          }
          const result = await browser[request.method](...request.args);
          if (request.method === 'status') result.daemonPid = process.pid;
          socket.write(`${JSON.stringify({ id: request.id, result })}\n`);
        } catch (error) {
          socket.write(`${JSON.stringify({ id: request?.id ?? null, error: errorMessage(error) })}\n`);
        }
      }
    })().catch(error => {
      process.stderr.write(`Browser broker client failed: ${errorMessage(error)}\n`);
      socket.destroy();
    });
  });

  const close = async () => {
    if (stopping) return;
    stopping = true;
    for (const socket of connections) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    browser.close();
    try {
      if ((await lstat(paths.socket)).ino === boundIno) await unlink(paths.socket);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  };

  try {
    await prepareSocket(paths.socket);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(paths.socket, resolve);
    });
    await chmod(paths.socket, 0o600);
    boundIno = (await lstat(paths.socket)).ino;
  } finally {
    await releaseStartLock();
  }
  return { server, close, socketPath: paths.socket };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startBroker().then(({ close }) => {
    process.stderr.write(`browserctl broker ${process.pid} listening\n`);
    process.on('SIGINT', () => { void close(); });
    process.on('SIGTERM', () => { void close(); });
  }).catch(error => {
    process.stderr.write(`Browser broker startup failed: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
