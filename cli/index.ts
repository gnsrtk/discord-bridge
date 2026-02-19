#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { writeFileSync, readFileSync, unlinkSync, openSync, closeSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadConfig, type Config, type Server } from '../src/config.js';
import { startServerBot, warnDuplicateChannels } from '../src/bot.js';
import { type Client } from 'discord.js';

const CONFIG_DIR = join(homedir(), '.discord-bridge');
const PID_FILE = join(CONFIG_DIR, 'discord-bridge.pid');
const LOG_FILE = join(CONFIG_DIR, 'discord-bridge.log');

export function escapeTmuxShellArg(value: string): string {
  return value.replace(/["$`\\]/g, '\\$&');
}

export function tmuxSessionExists(session: string): boolean {
  try {
    execFileSync('tmux', ['has-session', '-t', session]);
    return true;
  } catch {
    return false;
  }
}

export function tmuxWindowExists(session: string, windowName: string): boolean {
  try {
    const out = execFileSync('tmux', ['list-windows', '-t', session, '-F', '#{window_name}'], {
      encoding: 'utf8',
    });
    return out.split('\n').map((s) => s.trim()).filter(Boolean).includes(windowName);
  } catch {
    return false;
  }
}

export function setupTmuxWindowsForServer(server: Server): void {
  const session = server.tmux.session;

  if (!tmuxSessionExists(session)) {
    try {
      execFileSync('tmux', ['new-session', '-d', '-s', session]);
      console.log(`[discord-bridge] Session "${session}" created`);
    } catch (err) {
      console.error(`[discord-bridge] Failed to create session "${session}":`, err);
      return;
    }
  }

  for (const project of server.projects) {
    if (tmuxWindowExists(session, project.name)) continue;

    try {
      execFileSync('tmux', ['new-window', '-t', `${session}:`, '-n', project.name, '-d']);
      execFileSync('tmux', [
        'send-keys', '-t', `${session}:${project.name}`,
        `cd "${escapeTmuxShellArg(project.projectPath)}" && claude --model "${escapeTmuxShellArg(project.model)}"`,
        'Enter',
      ]);
      console.log(`[discord-bridge] Window "${project.name}" created → ${project.projectPath}`);
    } catch (err) {
      console.error(`[discord-bridge] Failed to create window "${project.name}":`, err);
    }
  }
}

export function setupTmuxWindows(config: Config): void {
  for (const server of config.servers) {
    setupTmuxWindowsForServer(server);
  }
}

export function readPid(): number | null {
  try {
    const raw = readFileSync(PID_FILE, 'utf-8').trim();
    const pid = parseInt(raw, 10);
    return isNaN(pid) || pid <= 0 ? null : pid;
  } catch {
    return null;
  }
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isNodeProcess(pid: number): boolean {
  try {
    const args = execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' });
    return args.toLowerCase().includes('node');
  } catch {
    // ps コマンドが失敗した場合は確認不能なのでそのまま kill を許可
    return true;
  }
}

async function runDaemon(): Promise<void> {
  const config = loadConfig();
  warnDuplicateChannels(config);
  setupTmuxWindows(config);

  const clients: Client[] = [];
  for (const server of config.servers) {
    const client = await startServerBot(server);
    clients.push(client);
  }

  const shutdown = () => {
    for (const client of clients) client.destroy();
    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export function runCli(command: string | undefined): void {
  const isDaemon = process.argv.includes('--daemon');

  switch (command) {
    case 'start': {
      if (isDaemon) {
        runDaemon().catch((err) => {
          console.error('[discord-bridge] Fatal error:', err);
          process.exit(1);
        });
      } else {
        const existingPid = readPid();
        if (existingPid !== null && isProcessRunning(existingPid)) {
          console.log(`[discord-bridge] Already running (PID ${existingPid})`);
          process.exit(0);
        }

        mkdirSync(CONFIG_DIR, { recursive: true });

        const self = fileURLToPath(import.meta.url);
        const logFd = openSync(LOG_FILE, 'a');
        const child = spawn(process.execPath, [self, 'start', '--daemon'], {
          detached: true,
          stdio: ['ignore', logFd, logFd],
        });
        closeSync(logFd);
        child.unref();

        writeFileSync(PID_FILE, String(child.pid));
        console.log(`[discord-bridge] Started (PID ${child.pid})`);
        console.log(`[discord-bridge] Log: ${LOG_FILE}`);
        process.exit(0);
      }
      break;
    }

    case 'stop': {
      const pid = readPid();
      if (pid === null || !isProcessRunning(pid)) {
        console.log('[discord-bridge] Not running');
        process.exit(0);
      }
      if (!isNodeProcess(pid)) {
        console.warn(`[discord-bridge] PID ${pid} does not appear to be a Node.js process. Skipping kill.`);
        try { unlinkSync(PID_FILE); } catch { /* ignore */ }
        process.exit(1);
      }
      process.kill(pid, 'SIGTERM');
      try { unlinkSync(PID_FILE); } catch { /* ignore */ }
      console.log(`[discord-bridge] Stopped (PID ${pid})`);
      break;
    }

    case 'status': {
      const pid = readPid();
      if (pid !== null && isProcessRunning(pid)) {
        console.log(`[discord-bridge] Running (PID ${pid})`);
      } else {
        console.log('[discord-bridge] Not running');
      }
      break;
    }

    default:
      console.log('Usage: discord-bridge <start|stop|status>');
      process.exit(1);
  }
}

// テスト環境では自動実行しない
/* c8 ignore next 3 */
if (process.env['NODE_ENV'] !== 'test' && !process.env['VITEST']) {
  runCli(process.argv[2]);
}
