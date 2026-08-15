import { spawn } from 'child_process';
import { loadSecretsIntoEnv } from '../src/config/secrets/load-secrets';

/**
 * Prefetch secrets then run a child command (migrations, seeds).
 *
 *   npx ts-node -r tsconfig-paths/register scripts/with-secrets.ts -- npm run migration:run
 */
async function main() {
  await loadSecretsIntoEnv();

  let args = process.argv.slice(2);
  if (args[0] === '--') args = args.slice(1);
  if (args.length === 0) {
    console.error('Usage: with-secrets.ts -- <command> [args...]');
    process.exit(2);
  }

  const child = spawn(args[0], args.slice(1), {
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
  });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
