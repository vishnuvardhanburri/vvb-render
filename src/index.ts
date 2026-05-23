// Entry point - loads the compiled application from dist/
// This file exists so that `node src/index.ts` works on Render
// (Node 24 can execute this as valid JS since it contains no TypeScript syntax)
import('../dist/main.js').catch(err => {
  console.error('Failed to start server:', err.message);
  console.error('Make sure to run "npm run build" first.');
  process.exit(1);
});
