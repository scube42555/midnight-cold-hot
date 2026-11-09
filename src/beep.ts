import { spawn } from 'node:child_process';

/**
 * Sound the terminal bell so you notice when a script needs you.
 *   NO_BEEP=1     turns it off
 *   BEEP_CMD=...  also runs this command (for example a sound player), if the terminal bell is muted
 * Example: BEEP_CMD="paplay /usr/share/sounds/freedesktop/stereo/complete.oga"
 */
export const beep = (times = 1): void => {
  if (process.env.NO_BEEP) return;
  if (process.stdout.isTTY) {
    for (let i = 0; i < times; i++) setTimeout(() => process.stdout.write('\x07'), i * 250);
  }
  const cmd = process.env.BEEP_CMD;
  if (cmd) spawn(cmd, { shell: true, stdio: 'ignore', detached: true }).unref();
};
