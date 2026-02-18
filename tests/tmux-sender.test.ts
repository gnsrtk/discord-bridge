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

  test('テキストを -l フラグで送り、Enter を別コールで送る', () => {
    const sender = new TmuxSender('main:0');
    sender.send('hello world');

    const calls = vi.mocked(execFileSync).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(['tmux', ['send-keys', '-t', 'main:0', '-l', 'hello world'], { stdio: 'inherit' }]);
    expect(calls[1]).toEqual(['tmux', ['send-keys', '-t', 'main:0', 'Enter'], { stdio: 'inherit' }]);
  });

  test('シングルクォートを含む文字列を安全に渡せる', () => {
    const sender = new TmuxSender('session:1');
    sender.send("it's a test");

    const calls = vi.mocked(execFileSync).mock.calls;
    expect(calls[0]).toEqual(['tmux', ['send-keys', '-t', 'session:1', '-l', "it's a test"], { stdio: 'inherit' }]);
    expect(calls[1]).toEqual(['tmux', ['send-keys', '-t', 'session:1', 'Enter'], { stdio: 'inherit' }]);
  });
});
