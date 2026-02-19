import { execFileSync } from 'node:child_process';

export class TmuxSender {
  constructor(private readonly target: string) {}

  send(text: string): void {
    if (text.includes('\n')) {
      // Multi-line: use load-buffer + paste-buffer for bracketed paste.
      // send-keys -l treats newlines as Enter, splitting text into multiple inputs.
      execFileSync('tmux', ['load-buffer', '-'], {
        input: text,
        stdio: ['pipe', 'inherit', 'inherit'],
      });
      execFileSync('tmux', ['paste-buffer', '-d', '-p', '-t', this.target], {
        stdio: 'inherit',
      });
    } else {
      execFileSync('tmux', ['send-keys', '-t', this.target, '-l', text], {
        stdio: 'inherit',
      });
    }
    execFileSync('tmux', ['send-keys', '-t', this.target, 'Enter'], {
      stdio: 'inherit',
    });
  }
}
