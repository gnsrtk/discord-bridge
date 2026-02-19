import { describe, test, expect, vi, beforeEach } from 'vitest';
import { handleButtonInteraction, handleInteractionCreate } from '../src/bot.js';
import { TmuxSender } from '../src/tmux-sender.js';

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
    reply: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  });

  const map = new Map<string, TmuxSender>();
  const defaultSender = new TmuxSender('0:0');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('tmux 送信成功時は ✅ を返す', async () => {
    const btn = makeBtn();
    await handleInteractionCreate(btn, 'owner-123', map, defaultSender);
    expect(btn.reply).toHaveBeenCalledWith({ content: '✅ 選択: yes', ephemeral: true });
  });

  test('tmux 送信失敗時でも ❌ でインタラクションを acknowledge する', async () => {
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('tmux not found'); });
    const btn = makeBtn();
    await handleInteractionCreate(btn, 'owner-123', map, defaultSender);
    expect(btn.reply).toHaveBeenCalledWith({ content: '❌ 送信に失敗しました', ephemeral: true });
  });

  test('btn.reply が失敗してもエラーを伝播しない', async () => {
    const btn = makeBtn({ reply: vi.fn().mockRejectedValue(new Error('interaction expired')) });
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

  test('__other__ ボタンは tmux に送信せず案内リプライを返す', async () => {
    const btn = makeBtn({ customId: '__other__' });
    await handleInteractionCreate(btn, 'owner-123', map, defaultSender);
    expect(btn.reply).toHaveBeenCalledWith({ content: '📝 回答を入力してください', ephemeral: false });
    expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
  });

  test('__other__ ボタンの reply 失敗時もエラーを伝播しない', async () => {
    const btn = makeBtn({
      customId: '__other__',
      reply: vi.fn().mockRejectedValue(new Error('interaction expired')),
    });
    await expect(handleInteractionCreate(btn, 'owner-123', map, defaultSender)).resolves.toBeUndefined();
    expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
  });
});
