import { execFileSync } from 'node:child_process';

export function escapeTmuxShellArg(value: string): string {
  return value.replace(/["$`\\]/g, '\\$&');
}

export class TmuxSender {
  constructor(private readonly target: string) {}

  send(text: string): void {
    if (text.includes('\n')) {
      // Multi-line: send bracketed-paste sequence via send-keys -l, then
      // wait 100 ms, then send Enter.
      //
      // Why not paste-buffer + send-keys Enter?
      //   paste-buffer uses bufferevent_write() (libevent async I/O), so
      //   execFileSync returning does NOT guarantee the bytes have been
      //   flushed to the pty.  send-keys Enter can therefore deliver CR
      //   before ESC[201~ arrives, causing Claude Code to drop the Enter.
      //
      // Why send-keys -l (not paste-buffer)?
      //   send-keys -l goes through the synchronous window_pane_key → pty
      //   write path, so the entire ESC[200~…ESC[201~ sequence is committed
      //   before execFileSync returns.
      //
      // Why the 100 ms wait?
      //   send-keys returning only means tmux has written to the pty master.
      //   Claude Code's event loop still needs one iteration to read() the
      //   bytes and update its internal bracket-paste state.  Without this
      //   delay the subsequent Enter arrives before that processing completes
      //   and is silently dropped.  500 ms gives comfortable headroom even
      //   under moderate host load.
      //
      // Why send-keys Enter (not -l '\r')?
      //   Claude Code's input handler expects KEYC_ENTER (sent by the key
      //   name "Enter") to trigger execution after the paste sequence ends.
      //   A literal CR sent with -l is not treated the same way.
      execFileSync('tmux', [
        'send-keys', '-t', this.target, '-l',
        `\x1b[200~${text}\x1b[201~`,
      ], { stdio: 'inherit' });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      execFileSync('tmux', ['send-keys', '-t', this.target, 'Enter'], {
        stdio: 'inherit',
      });
    } else {
      execFileSync('tmux', ['send-keys', '-t', this.target, '-l', text], {
        stdio: 'inherit',
      });
      execFileSync('tmux', ['send-keys', '-t', this.target, 'Enter'], {
        stdio: 'inherit',
      });
    }
  }
}
