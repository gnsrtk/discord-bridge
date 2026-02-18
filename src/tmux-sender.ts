import { execFileSync } from 'node:child_process';

export class TmuxSender {
  constructor(private readonly target: string) {}

  send(text: string): void {
    execFileSync('tmux', ['send-keys', '-t', this.target, '-l', text], {
      stdio: 'inherit',
    });
    execFileSync('tmux', ['send-keys', '-t', this.target, 'Enter'], {
      stdio: 'inherit',
    });
  }
}
