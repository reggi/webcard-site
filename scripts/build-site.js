import { build } from 'vite';

try {
  await build();
} catch (error) {
  console.error(`Static build failed: ${error.message}`);
  process.exitCode = 1;
}
