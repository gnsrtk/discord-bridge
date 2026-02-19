import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeThreadTracking, handleInteractionCreate, handleButtonInteraction } from '../src/bot.js';
import { TmuxSender } from '../src/tmux-sender.js';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// writeThreadTracking
// ---------------------------------------------------------------------------

describe('writeThreadTracking', () => {
  const parentChannelId = 'test-wtt-parent-123';
  const trackingPath = `/tmp/discord-bridge-thread-${parentChannelId}.json`;

  afterEach(() => {
    try { unlinkSync(trackingPath); } catch { /* ignore */ }
  });

  test('threadId を書き込む', () => {
    writeThreadTracking(parentChannelId, 'thread-456');
    expect(existsSync(trackingPath)).toBe(true);
    const data = JSON.parse(readFileSync(trackingPath, 'utf-8'));
    expect(data.threadId).toBe('thread-456');
  });

  test('threadId が null の場合はファイルを削除する', () => {
    writeFileSync(trackingPath, JSON.stringify({ threadId: 'old-thread' }));
    writeThreadTracking(parentChannelId, null);
    expect(existsSync(trackingPath)).toBe(false);
  });

  test('ファイルが存在しない状態で null を渡してもエラーにならない', () => {
    expect(() => writeThreadTracking('nonexistent-channel-xyz', null)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// handleInteractionCreate with threadParentMap
// ---------------------------------------------------------------------------

describe('handleInteractionCreate with threadParentMap', () => {
  const makeBtn = (overrides: object = {}) => ({
    isButton: () => true,
    user: { id: 'owner-123' },
    channelId: 'thread-ch-789',
    customId: '0:はい',
    reply: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  });

  const channelSenderMap = new Map<string, TmuxSender>([
    ['parent-ch-111', new TmuxSender('0:1')],
  ]);
  const defaultSender = new TmuxSender('0:0');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('スレッド内ボタン → threadParentMap で親チャンネルの sender を使用', async () => {
    const threadParentMap = new Map([['thread-ch-789', 'parent-ch-111']]);
    const btn = makeBtn();

    await handleInteractionCreate(btn, 'owner-123', channelSenderMap, defaultSender, threadParentMap);

    const calls = vi.mocked(execFileSync).mock.calls;
    // parent-ch-111 の sender (0:1) で送信される
    expect(calls[0]).toEqual(['tmux', ['send-keys', '-t', '0:1', '-l', 'はい'], { stdio: 'inherit' }]);
  });

  test('threadParentMap に登録なし → defaultSender を使用', async () => {
    const threadParentMap = new Map<string, string>();
    const btn = makeBtn();

    await handleInteractionCreate(btn, 'owner-123', channelSenderMap, defaultSender, threadParentMap);

    const calls = vi.mocked(execFileSync).mock.calls;
    // defaultSender (0:0) で送信される
    expect(calls[0]).toEqual(['tmux', ['send-keys', '-t', '0:0', '-l', 'はい'], { stdio: 'inherit' }]);
  });

  test('threadParentMap undefined (後方互換) → defaultSender を使用', async () => {
    const btn = makeBtn();

    await handleInteractionCreate(btn, 'owner-123', channelSenderMap, defaultSender);

    const calls = vi.mocked(execFileSync).mock.calls;
    expect(calls[0]).toEqual(['tmux', ['send-keys', '-t', '0:0', '-l', 'はい'], { stdio: 'inherit' }]);
  });

  test('perm: ボタン in スレッド → threadParentMap で親チャンネルID解決して IPC ファイルパス一致', async () => {
    const threadParentMap = new Map([['111222333444555', 'parent-ch-111']]);
    const btn = makeBtn({
      customId: 'perm:allow',
      channelId: '111222333444555',
    });
    const respPath = '/tmp/discord-bridge-perm-parent-ch-111.json';
    try { unlinkSync(respPath); } catch { /* ignore */ }

    await handleInteractionCreate(btn, 'owner-123', channelSenderMap, defaultSender, threadParentMap);

    expect(btn.reply).toHaveBeenCalledWith({ content: '✅ 許可しました', ephemeral: false });
    expect(existsSync(respPath)).toBe(true);
    const data = JSON.parse(readFileSync(respPath, 'utf-8'));
    expect(data.decision).toBe('allow');

    try { unlinkSync(respPath); } catch { /* ignore */ }
  });
});
