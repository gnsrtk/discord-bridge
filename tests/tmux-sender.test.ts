import { describe, test, expect, vi, beforeEach } from 'vitest';
import { TmuxSender } from '../src/tmux-sender.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';

describe('TmuxSender', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('単一行: send-keys -l で送り、Enter を別コールで送る', () => {
    const sender = new TmuxSender('main:0');
    sender.send('hello world');

    const calls = vi.mocked(execFileSync).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(['tmux', ['send-keys', '-t', 'main:0', '-l', 'hello world'], { stdio: 'inherit' }]);
    expect(calls[1]).toEqual(['tmux', ['send-keys', '-t', 'main:0', 'Enter'], { stdio: 'inherit' }]);
  });

  test('シングルクォートを含む単一行を安全に渡せる', () => {
    const sender = new TmuxSender('session:1');
    sender.send("it's a test");

    const calls = vi.mocked(execFileSync).mock.calls;
    expect(calls[0]).toEqual(['tmux', ['send-keys', '-t', 'session:1', '-l', "it's a test"], { stdio: 'inherit' }]);
    expect(calls[1]).toEqual(['tmux', ['send-keys', '-t', 'session:1', 'Enter'], { stdio: 'inherit' }]);
  });

  test('複数行: send-keys -l でブラケットペーストシーケンスを送り、Enter を別コールで送る', () => {
    const sender = new TmuxSender('main:0');
    sender.send('line1\nline2\nline3');

    const calls = vi.mocked(execFileSync).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual([
      'tmux',
      ['send-keys', '-t', 'main:0', '-l', '\x1b[200~line1\nline2\nline3\x1b[201~'],
      { stdio: 'inherit' },
    ]);
    expect(calls[1]).toEqual(['tmux', ['send-keys', '-t', 'main:0', 'Enter'], { stdio: 'inherit' }]);
  });

  test('改行1つだけでも send-keys -l + Enter 経由になる', () => {
    const sender = new TmuxSender('sess:2');
    sender.send('first\nsecond');

    const calls = vi.mocked(execFileSync).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toBe('tmux');
    expect(calls[0][1]).toEqual(['send-keys', '-t', 'sess:2', '-l', '\x1b[200~first\nsecond\x1b[201~']);
    expect(calls[1]).toEqual(['tmux', ['send-keys', '-t', 'sess:2', 'Enter'], { stdio: 'inherit' }]);
  });
});
