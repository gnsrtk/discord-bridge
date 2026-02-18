import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('node:fs', () => ({
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  openSync: vi.fn().mockReturnValue(3),
  closeSync: vi.fn(),
}));

// cli/index.ts のトップレベルコードがテスト実行時に副作用を起こさないよう抑制
vi.mock('../src/config.js', () => ({
  loadConfig: vi.fn(),
}));

vi.mock('../src/bot.js', () => ({
  startBot: vi.fn(),
}));

// process.exit をモックしてトップレベルの runCli() default ブランチを無害化
// vi.hoisted を使って import より前にモックを設定する
const mockExit = vi.hoisted(() => vi.fn());
vi.stubGlobal('process', { ...process, exit: mockExit });

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  tmuxSessionExists,
  tmuxWindowExists,
  setupTmuxWindows,
  readPid,
  isProcessRunning,
} from '../cli/index.js';
import type { Config } from '../src/config.js';

const mockExecFileSync = vi.mocked(execFileSync);
const mockReadFileSync = vi.mocked(readFileSync);

const makeConfig = (overrides: Partial<Config> = {}): Config => ({
  schemaVersion: 1,
  tmux: { session: 'test-session' },
  discord: {
    botToken: 'Bot.token',
    guildId: '111',
    ownerUserId: '222',
  },
  projects: [
    {
      name: 'project-a',
      channelId: '444',
      projectPath: '/projects/a',
      model: 'claude-opus-4-6',
    },
  ],
  ...overrides,
});

describe('tmuxSessionExists', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('セッションが存在する場合は true を返す', () => {
    mockExecFileSync.mockReturnValue(Buffer.from(''));
    expect(tmuxSessionExists('test-session')).toBe(true);
    expect(mockExecFileSync).toHaveBeenCalledWith('tmux', ['has-session', '-t', 'test-session']);
  });

  it('セッションが存在しない場合（execFileSync が例外をスロー）は false を返す', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('no server running on ...');
    });
    expect(tmuxSessionExists('nonexistent')).toBe(false);
  });
});

describe('tmuxWindowExists', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ウィンドウ一覧に含まれる場合は true を返す', () => {
    mockExecFileSync.mockReturnValue('project-a\nproject-b\n');
    expect(tmuxWindowExists('test-session', 'project-a')).toBe(true);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'tmux',
      ['list-windows', '-t', 'test-session', '-F', '#{window_name}'],
      { encoding: 'utf8' },
    );
  });

  it('ウィンドウ一覧に含まれない場合は false を返す', () => {
    mockExecFileSync.mockReturnValue('project-b\nproject-c\n');
    expect(tmuxWindowExists('test-session', 'project-a')).toBe(false);
  });
});

describe('setupTmuxWindows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('セッションが存在しない場合は new-session が呼ばれる', () => {
    mockExecFileSync
      .mockImplementationOnce(() => {
        throw new Error('no server running');
      }) // has-session
      .mockReturnValue(''); // list-windows / new-session / new-window / send-keys

    const config = makeConfig();
    setupTmuxWindows(config);

    const calls = mockExecFileSync.mock.calls;
    const newSessionCall = calls.find(
      (c) => c[0] === 'tmux' && Array.isArray(c[1]) && c[1][0] === 'new-session',
    );
    expect(newSessionCall).toBeDefined();
    expect(newSessionCall![1]).toEqual(['new-session', '-d', '-s', 'test-session']);
  });

  it('ウィンドウが存在しない場合は new-window と send-keys が呼ばれる', () => {
    mockExecFileSync
      .mockReturnValueOnce(Buffer.from('')) // has-session
      .mockReturnValueOnce('')              // list-windows
      .mockReturnValue(Buffer.from(''));    // new-window, send-keys

    const config = makeConfig();
    setupTmuxWindows(config);

    const calls = mockExecFileSync.mock.calls;
    const newWindowCall = calls.find(
      (c) => c[0] === 'tmux' && Array.isArray(c[1]) && c[1][0] === 'new-window',
    );
    const sendKeysCall = calls.find(
      (c) => c[0] === 'tmux' && Array.isArray(c[1]) && c[1][0] === 'send-keys',
    );
    expect(newWindowCall).toBeDefined();
    expect(newWindowCall![1]).toEqual(['new-window', '-t', 'test-session:', '-n', 'project-a', '-d']);
    expect(sendKeysCall).toBeDefined();
    expect(sendKeysCall![1][0]).toBe('send-keys');
    expect(sendKeysCall![1][1]).toBe('-t');
    expect(sendKeysCall![1][2]).toBe('test-session:project-a');
    expect(sendKeysCall![1][3]).toContain('--model');
    expect(sendKeysCall![1][3]).toContain('claude-opus-4-6');
  });

  it('ウィンドウが既に存在する場合は new-window が呼ばれない', () => {
    mockExecFileSync
      .mockReturnValueOnce(Buffer.from('')) // has-session
      .mockReturnValueOnce('project-a\n'); // list-windows

    const config = makeConfig();
    setupTmuxWindows(config);

    const calls = mockExecFileSync.mock.calls;
    const newWindowCall = calls.find(
      (c) => c[0] === 'tmux' && Array.isArray(c[1]) && c[1][0] === 'new-window',
    );
    expect(newWindowCall).toBeUndefined();
  });
});

describe('readPid', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('PID ファイルが存在する場合は数値を返す', () => {
    mockReadFileSync.mockReturnValue('12345');
    expect(readPid()).toBe(12345);
  });

  it('PID ファイルが存在しない場合は null を返す', () => {
    mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    expect(readPid()).toBeNull();
  });

  it('PID ファイルの内容が数値でない場合は null を返す', () => {
    mockReadFileSync.mockReturnValue('not-a-number');
    expect(readPid()).toBeNull();
  });
});

describe('isProcessRunning', () => {
  it('プロセスが存在する場合は true を返す', () => {
    const mockKill = vi.spyOn(process, 'kill').mockReturnValue(true);
    expect(isProcessRunning(12345)).toBe(true);
    expect(mockKill).toHaveBeenCalledWith(12345, 0);
    mockKill.mockRestore();
  });

  it('プロセスが存在しない場合は false を返す', () => {
    const mockKill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });
    expect(isProcessRunning(99999)).toBe(false);
    mockKill.mockRestore();
  });
});
