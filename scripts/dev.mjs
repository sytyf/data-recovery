import { spawn } from 'child_process';

const children = [
  spawn('node', ['server/server.js'], { stdio: 'inherit' }),
  spawn('vite', ['--host', '127.0.0.1'], { stdio: 'inherit' })
];

function shutdown(signal) {
  for (const child of children) child.kill(signal);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

for (const child of children) {
  child.on('exit', (code) => {
    if (code && code !== 0) {
      shutdown('SIGTERM');
      process.exit(code);
    }
  });
}
