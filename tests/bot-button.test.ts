import { describe, test, expect, vi, beforeEach } from 'vitest';
import { handleButtonInteraction, handleInteractionCreate } from '../src/bot.js';
import { TmuxSender } from '../src/tmux-sender.js';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';

describe('handleButtonInteraction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('channelSenderMap に一致するチャンネルの TmuxSender でテキストを送る', () => {
    const sender1 = new TmuxSender('0:1');
    const sender2 = new TmuxSender('0:2');
    const map = new Map([
      ['ch-111', sender1],
      ['ch-222', sender2],
    ]);
    const defaultSender = new TmuxSender('0:0');

    handleButtonInteraction('ch-222', '選択肢B', map, defaultSender);

    const calls = vi.mocked(execFileSync).mock.calls;
    expect(calls[0]).toEqual(['tmux', ['send-keys', '-t', '0:2', '-l', '選択肢B'], { stdio: 'inherit' }]);
  });

  test('channelSenderMap に一致しない場合は defaultSender を使う', () => {
    const map = new Map<string, TmuxSender>();
    const defaultSender = new TmuxSender('0:0');

    handleButtonInteraction('unknown-ch', 'Option X', map, defaultSender);

    const calls = vi.mocked(execFileSync).mock.calls;
    expect(calls[0]).toEqual(['tmux', ['send-keys', '-t', '0:0', '-l', 'Option X'], { stdio: 'inherit' }]);
  });
});

describe('handleInteractionCreate', () => {
  const makeBtn = (overrides: object = {}) => ({
    isButton: () => true,
    user: { id: 'owner-123' },
    channelId: 'ch-abc',
    customId: 'yes',
    message: { content: '元のメッセージ' },
    reply: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  });

  const map = new Map<string, TmuxSender>();
  const defaultSender = new TmuxSender('0:0');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('tmux 送信成功時は ✅ で update を呼ぶ', async () => {
    const btn = makeBtn();
    await handleInteractionCreate(btn, 'owner-123', map, defaultSender);
    expect(btn.update).toHaveBeenCalledWith({
      content: '元のメッセージ\n\n✅ 選択: yes',
      components: [],
    });
  });

  test('tmux 送信失敗時でも ❌ で update を呼ぶ', async () => {
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('tmux not found'); });
    const btn = makeBtn();
    await handleInteractionCreate(btn, 'owner-123', map, defaultSender);
    expect(btn.update).toHaveBeenCalledWith({
      content: '元のメッセージ\n\n❌ 送信失敗: yes',
      components: [],
    });
  });

  test('btn.update が失敗してもエラーを伝播しない', async () => {
    const btn = makeBtn({ update: vi.fn().mockRejectedValue(new Error('interaction expired')) });
    await expect(handleInteractionCreate(btn, 'owner-123', map, defaultSender)).resolves.toBeUndefined();
  });

  test('ボタン以外のインタラクションは無視する', async () => {
    const interaction = { isButton: () => false, reply: vi.fn() };
    await handleInteractionCreate(interaction, 'owner-123', map, defaultSender);
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  test('ownerUserId 以外のユーザーには Unauthorized を返す', async () => {
    const btn = makeBtn({ user: { id: 'other-user' } });
    await handleInteractionCreate(btn, 'owner-123', map, defaultSender);
    expect(btn.reply).toHaveBeenCalledWith({ content: 'Unauthorized', ephemeral: true });
  });

  test('__other__ ボタンは update + followUp を呼ぶ', async () => {
    const btn = makeBtn({ customId: '__other__' });
    await handleInteractionCreate(btn, 'owner-123', map, defaultSender);
    expect(btn.update).toHaveBeenCalledWith({ content: '元のメッセージ', components: [] });
    expect(btn.followUp).toHaveBeenCalledWith({ content: '📝 回答を入力してください' });
    expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
  });

  test('__other__ ボタンの update 失敗時もエラーを伝播しない', async () => {
    const btn = makeBtn({
      customId: '__other__',
      update: vi.fn().mockRejectedValue(new Error('interaction expired')),
    });
    await expect(handleInteractionCreate(btn, 'owner-123', map, defaultSender)).resolves.toBeUndefined();
    expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
  });

  // perm: ボタンテスト
  test('perm:allow → ファイル書き込み + 許可リプライ', async () => {
    const btn = makeBtn({ customId: 'perm:allow', channelId: '111222333444555' });
    const respPath = '/tmp/discord-bridge-perm-111222333444555.json';
    try { unlinkSync(respPath); } catch { /* ignore */ }

    await handleInteractionCreate(btn, 'owner-123', map, defaultSender);

    expect(btn.reply).toHaveBeenCalledWith({ content: '✅ Allowed', ephemeral: false });
    expect(existsSync(respPath)).toBe(true);
    const data = JSON.parse(readFileSync(respPath, 'utf-8'));
    expect(data.decision).toBe('allow');
    expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();

    try { unlinkSync(respPath); } catch { /* ignore */ }
  });

  test('perm:deny → ファイル書き込み + 拒否リプライ', async () => {
    const btn = makeBtn({ customId: 'perm:deny', channelId: '222333444555666' });
    const respPath = '/tmp/discord-bridge-perm-222333444555666.json';
    try { unlinkSync(respPath); } catch { /* ignore */ }

    await handleInteractionCreate(btn, 'owner-123', map, defaultSender);

    expect(btn.reply).toHaveBeenCalledWith({ content: '❌ Denied', ephemeral: false });
    expect(existsSync(respPath)).toBe(true);
    const data = JSON.parse(readFileSync(respPath, 'utf-8'));
    expect(data.decision).toBe('deny');
    expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();

    try { unlinkSync(respPath); } catch { /* ignore */ }
  });

  test('perm:other → block ファイル書き込み + 理由入力案内リプライ', async () => {
    const btn = makeBtn({ customId: 'perm:other', channelId: '999888777666555' });
    const respPath = '/tmp/discord-bridge-perm-999888777666555.json';
    try { unlinkSync(respPath); } catch { /* ignore */ }

    await handleInteractionCreate(btn, 'owner-123', map, defaultSender);

    expect(btn.reply).toHaveBeenCalledWith({ content: '📝 Please enter your reason', ephemeral: false });
    expect(existsSync(respPath)).toBe(true);
    const data = JSON.parse(readFileSync(respPath, 'utf-8'));
    expect(data.decision).toBe('block');
    expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();

    try { unlinkSync(respPath); } catch { /* ignore */ }
  });
});
