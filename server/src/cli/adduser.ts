// pnpm --filter server adduser <name>
//
// Interactively adds a user to ~/.config/remote-ide/users.json. Password is
// read from stdin with echo suppressed (sudo-style — no character feedback)
// and confirmed twice to catch typos.

import { addUser } from '../users.js';

function promptPassword(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (!stdin.isTTY) {
      reject(new Error('not a tty — interactive password entry only'));
      return;
    }
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(wasRaw);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(buf);
          return;
        }
        if (c === '\x03') { // Ctrl-C
          stdin.setRawMode(wasRaw);
          stdin.pause();
          process.stdout.write('\n');
          process.exit(130);
        }
        if (c === '\x7f' || c === '\b') { // DEL or backspace
          buf = buf.slice(0, -1);
          continue;
        }
        buf += c;
      }
    };
    stdin.on('data', onData);
  });
}

async function main() {
  const name = process.argv[2];
  if (!name) {
    process.stderr.write('Usage: pnpm --filter server adduser <name>\n');
    process.exit(2);
  }
  const pwd1 = await promptPassword(`Password for ${name}: `);
  if (pwd1.length < 6) {
    process.stderr.write('Password must be at least 6 characters.\n');
    process.exit(1);
  }
  const pwd2 = await promptPassword('Confirm password:  ');
  if (pwd1 !== pwd2) {
    process.stderr.write('Passwords do not match.\n');
    process.exit(1);
  }
  try {
    const u = await addUser(name, pwd1);
    process.stdout.write(`Created user "${u.name}" (id=${u.id}).\n`);
  } catch (e: any) {
    process.stderr.write(`Failed: ${e.message}\n`);
    process.exit(1);
  }
}

main();
