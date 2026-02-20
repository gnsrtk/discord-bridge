import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  writeThreadTracking,
  handleInteractionCreate,
  handleButtonInteraction,
  createThreadPane,
  killThreadPane,
  buildPermissionFlag,
} from '../src/bot.js';
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

    expect(btn.reply).toHaveBeenCalledWith({ content: '✅ Allowed', ephemeral: false });
    expect(existsSync(respPath)).toBe(true);
    const data = JSON.parse(readFileSync(respPath, 'utf-8'));
    expect(data.decision).toBe('allow');

    try { unlinkSync(respPath); } catch { /* ignore */ }
  });
});

// ---------------------------------------------------------------------------
// buildPermissionFlag
// ---------------------------------------------------------------------------

describe('buildPermissionFlag', () => {
  test('bypassPermissions → --dangerously-skip-permissions', () => {
    expect(buildPermissionFlag('bypassPermissions')).toBe(' --dangerously-skip-permissions');
  });

  test('undefined → 空文字列', () => {
    expect(buildPermissionFlag(undefined)).toBe('');
  });

  test('default → 空文字列', () => {
    expect(buildPermissionFlag('default')).toBe('');
  });

  test('未知の値 → 空文字列', () => {
    expect(buildPermissionFlag('unknown')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// createThreadPane
// ---------------------------------------------------------------------------

describe('createThreadPane', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('split-window + send-keys を実行し pane ID を返す', () => {
    vi.mocked(execFileSync)
      .mockReturnValueOnce('%42\n' as unknown as Buffer)  // split-window → pane ID
      .mockReturnValueOnce('' as unknown as Buffer);       // send-keys

    const paneId = createThreadPane('sess', 'proj-win', '/path/to/project', 'opus', 'thread-999');

    expect(paneId).toBe('%42');
    const calls = vi.mocked(execFileSync).mock.calls;
    expect(calls[0]).toEqual([
      'tmux',
      ['split-window', '-t', 'sess:proj-win', '-d', '-P', '-F', '#{pane_id}'],
      { encoding: 'utf8' },
    ]);
    expect(calls[1][0]).toBe('tmux');
    expect(calls[1][1][0]).toBe('send-keys');
    expect(calls[1][1][1]).toBe('-t');
    expect(calls[1][1][2]).toBe('%42');
    // cmd に DISCORD_BRIDGE_THREAD_ID が含まれる
    const cmd = calls[1][1][3] as string;
    expect(cmd).toContain('DISCORD_BRIDGE_THREAD_ID=thread-999');
    expect(cmd).toContain('/path/to/project');
    expect(cmd).toContain('claude --model');
    expect(cmd).not.toContain('--dangerously-skip-permissions');
  });

  test('permission=bypassPermissions → --dangerously-skip-permissions が cmd に含まれる', () => {
    vi.mocked(execFileSync)
      .mockReturnValueOnce('%43\n' as unknown as Buffer)
      .mockReturnValueOnce('' as unknown as Buffer);

    createThreadPane('sess', 'win', '/path', 'haiku', 'th-2', 'bypassPermissions');

    const cmd = vi.mocked(execFileSync).mock.calls[1][1][3] as string;
    expect(cmd).toContain('--dangerously-skip-permissions');
  });

  test('thread.model でモデルオーバーライド', () => {
    vi.mocked(execFileSync)
      .mockReturnValueOnce('%44\n' as unknown as Buffer)
      .mockReturnValueOnce('' as unknown as Buffer);

    createThreadPane('sess', 'win', '/path', 'claude-haiku-4-5-20251001', 'th-3');

    const cmd = vi.mocked(execFileSync).mock.calls[1][1][3] as string;
    expect(cmd).toContain('claude-haiku-4-5-20251001');
  });

  test('split-window 失敗時はエラーを伝播する', () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => { throw new Error('tmux error'); });
    expect(() => createThreadPane('sess', 'win', '/path', 'opus', 'th-1')).toThrow('tmux error');
  });
});

// ---------------------------------------------------------------------------
// killThreadPane
// ---------------------------------------------------------------------------

describe('killThreadPane', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('kill-pane コマンドを実行する', () => {
    killThreadPane('%42');
    const calls = vi.mocked(execFileSync).mock.calls;
    expect(calls[0]).toEqual(['tmux', ['kill-pane', '-t', '%42']]);
  });

  test('pane が存在しなくてもエラーにならない', () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => { throw new Error('pane not found'); });
    expect(() => killThreadPane('%99')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// handleButtonInteraction with threadPaneMap
// ---------------------------------------------------------------------------

describe('handleButtonInteraction with threadPaneMap', () => {
  const channelSenderMap = new Map<string, TmuxSender>([
    ['parent-ch-111', new TmuxSender('0:1')],
  ]);
  const defaultSender = new TmuxSender('0:0');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('threadPaneMap にエントリあり → pane sender を使用', () => {
    const threadPaneMap = new Map([['thread-ch-abc', '%55']]);
    handleButtonInteraction('parent-ch-111', '0:はい', channelSenderMap, defaultSender, 'thread-ch-abc', threadPaneMap);

    const calls = vi.mocked(execFileSync).mock.calls;
    // pane %55 の sender で送信される
    expect(calls[0]).toEqual(['tmux', ['send-keys', '-t', '%55', '-l', 'はい'], { stdio: 'inherit' }]);
  });

  test('threadPaneMap にエントリなし → 通常の channelSenderMap を使用', () => {
    const threadPaneMap = new Map<string, string>();
    handleButtonInteraction('parent-ch-111', '0:はい', channelSenderMap, defaultSender, 'thread-ch-abc', threadPaneMap);

    const calls = vi.mocked(execFileSync).mock.calls;
    expect(calls[0]).toEqual(['tmux', ['send-keys', '-t', '0:1', '-l', 'はい'], { stdio: 'inherit' }]);
  });

  test('originalChannelId undefined → channelSenderMap を使用', () => {
    const threadPaneMap = new Map([['thread-ch-abc', '%55']]);
    handleButtonInteraction('parent-ch-111', '0:はい', channelSenderMap, defaultSender, undefined, threadPaneMap);

    const calls = vi.mocked(execFileSync).mock.calls;
    expect(calls[0]).toEqual(['tmux', ['send-keys', '-t', '0:1', '-l', 'はい'], { stdio: 'inherit' }]);
  });
});

// ---------------------------------------------------------------------------
// handleInteractionCreate with threadPaneMap
// ---------------------------------------------------------------------------

describe('handleInteractionCreate with threadPaneMap', () => {
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

  test('スレッド内ボタン + threadPaneMap あり → pane sender を使用', async () => {
    const threadParentMap = new Map([['thread-ch-789', 'parent-ch-111']]);
    const threadPaneMap = new Map([['thread-ch-789', '%60']]);
    const btn = makeBtn();

    await handleInteractionCreate(btn, 'owner-123', channelSenderMap, defaultSender, threadParentMap, threadPaneMap);

    const calls = vi.mocked(execFileSync).mock.calls;
    // pane %60 で送信される
    expect(calls[0]).toEqual(['tmux', ['send-keys', '-t', '%60', '-l', 'はい'], { stdio: 'inherit' }]);
  });

  test('スレッド内ボタン + threadPaneMap なし → 親 sender を使用', async () => {
    const threadParentMap = new Map([['thread-ch-789', 'parent-ch-111']]);
    const threadPaneMap = new Map<string, string>();
    const btn = makeBtn();

    await handleInteractionCreate(btn, 'owner-123', channelSenderMap, defaultSender, threadParentMap, threadPaneMap);

    const calls = vi.mocked(execFileSync).mock.calls;
    expect(calls[0]).toEqual(['tmux', ['send-keys', '-t', '0:1', '-l', 'はい'], { stdio: 'inherit' }]);
  });
});
