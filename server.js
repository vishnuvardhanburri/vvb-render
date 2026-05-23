// Server entry point for Render deployment
// This file loads the compiled TypeScript from dist/
import('./dist/main.js').catch(err => {
  console.error('Failed to start server:', err.message);
  console.error('Make sure to run "npm run build" first.');
  process.exit(1);
});
