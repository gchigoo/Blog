const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TEST_NODE_PATH = [
  path.join(REPO_ROOT, 'node_modules'),
  process.env.NODE_PATH
].filter(Boolean).join(path.delimiter);
const cleanupManagers = new WeakMap();

function registerCleanup(t, cleanup) {
  let manager = cleanupManagers.get(t);
  if (!manager) {
    manager = { tasks: [] };
    cleanupManagers.set(t, manager);
    t.after(async () => {
      for (const task of manager.tasks.reverse()) {
        await task();
      }
    });
  }
  manager.tasks.push(cleanup);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;

  child.kill('SIGTERM');
  await Promise.race([
    once(child, 'exit'),
    new Promise(resolve => setTimeout(resolve, 2_000))
  ]);

  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await Promise.race([
      once(child, 'exit'),
      new Promise(resolve => setTimeout(resolve, 2_000))
    ]);
  }
}

async function createProjectFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blog-security-'));

  for (const directory of ['server', 'scripts', 'views', 'public']) {
    await fs.cp(
      path.join(REPO_ROOT, directory),
      path.join(root, directory),
      { recursive: true }
    );
  }

  await fs.mkdir(path.join(root, 'articles'), { recursive: true });
  await fs.mkdir(path.join(root, 'uploads', 'temp'), { recursive: true });
  await fs.mkdir(path.join(root, 'public', 'images'), { recursive: true });
  registerCleanup(t, async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  return root;
}

function runNode(root, script, args = [], env = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    env: { ...process.env, NODE_PATH: TEST_NODE_PATH, ...env },
    encoding: 'utf8',
    input: '',
    timeout: 15_000
  });
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function startServer(t, root, env = {}) {
  const port = await getFreePort();
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      JWT_SECRET: 'test-only-jwt-secret-with-at-least-32-characters',
      NODE_PATH: TEST_NODE_PATH,
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });

  registerCleanup(t, async () => {
    await stopChild(child);
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited before readiness (${child.exitCode})\n${output}`);
    }

    try {
      const response = await fetch(baseUrl);
      if (response.status < 500) return { baseUrl, child, getOutput: () => output };
    } catch {
      // Retry until the child has bound the port.
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  child.kill('SIGTERM');
  throw new Error(`server readiness timeout\n${output}`);
}

module.exports = {
  REPO_ROOT,
  createProjectFixture,
  runNode,
  startServer
};
