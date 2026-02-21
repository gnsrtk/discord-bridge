import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ThreadStateManager, type ThreadPaneInfo } from '../src/thread-state.js';

const TMP_DIR = join(tmpdir(), 'discord-bridge-thread-state-test');
const STATE_FILE = join(TMP_DIR, 'thread-state.json');

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

const makeInfo = (overrides: Partial<ThreadPaneInfo> = {}): ThreadPaneInfo => ({
  paneId: '%42',
  paneStartedAt: '2026-02-21T10:00:00Z',
  parentChannelId: 'ch-111',
  projectPath: '/path/to/project',
  serverName: 'personal',
  createdAt: '2026-02-21T10:00:00Z',
  launchCmd: 'claude --model opus -w',
  ...overrides,
});

describe('ThreadStateManager', () => {
  test('初期状態は空のマップ', () => {
    const mgr = new ThreadStateManager(STATE_FILE);
    expect(mgr.getAll().size).toBe(0);
  });

  test('set → get でエントリを保存・取得できる', () => {
    const mgr = new ThreadStateManager(STATE_FILE);
    mgr.set('thread-1', makeInfo());
    expect(mgr.get('thread-1')?.paneId).toBe('%42');
  });

  test('set で thread-state.json にアトミック書き込みされる', () => {
    const mgr = new ThreadStateManager(STATE_FILE);
    mgr.set('thread-1', makeInfo());
    expect(existsSync(STATE_FILE)).toBe(true);
    const data = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    expect(data.threads['thread-1'].paneId).toBe('%42');
  });

  test('remove でエントリを削除できる', () => {
    const mgr = new ThreadStateManager(STATE_FILE);
    mgr.set('thread-1', makeInfo());
    mgr.remove('thread-1');
    expect(mgr.get('thread-1')).toBeUndefined();
  });

  test('updateWorktreePath で worktreePath を追記できる', () => {
    const mgr = new ThreadStateManager(STATE_FILE);
    mgr.set('thread-1', makeInfo());
    mgr.updateWorktreePath('thread-1', '/path/.claude/worktrees/abc');
    expect(mgr.get('thread-1')?.worktreePath).toBe('/path/.claude/worktrees/abc');
  });

  test('load で既存ファイルから復元できる', () => {
    const mgr1 = new ThreadStateManager(STATE_FILE);
    mgr1.set('thread-1', makeInfo());
    // 新しいインスタンスで読み込み
    const mgr2 = new ThreadStateManager(STATE_FILE);
    expect(mgr2.get('thread-1')?.paneId).toBe('%42');
  });

  test('ファイルが存在しない場合は空で初期化', () => {
    const mgr = new ThreadStateManager(join(TMP_DIR, 'nonexistent.json'));
    expect(mgr.getAll().size).toBe(0);
  });

  test('ファイルが壊れている場合は空で初期化', () => {
    const corruptFile = join(TMP_DIR, 'corrupt.json');
    writeFileSync(corruptFile, 'not json');
    const mgr = new ThreadStateManager(corruptFile);
    expect(mgr.getAll().size).toBe(0);
  });

  test('getKnownWorktreePaths で既知の worktree パスセットを取得', () => {
    const mgr = new ThreadStateManager(STATE_FILE);
    mgr.set('thread-1', makeInfo({ worktreePath: '/path/a' }));
    mgr.set('thread-2', makeInfo({ worktreePath: '/path/b' }));
    mgr.set('thread-3', makeInfo()); // worktreePath なし
    const paths = mgr.getKnownWorktreePaths();
    expect(paths.size).toBe(2);
    expect(paths.has('/path/a')).toBe(true);
    expect(paths.has('/path/b')).toBe(true);
  });
});
