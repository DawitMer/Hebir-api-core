// Read-only deployment preflight. Run npm run build first.
// Usage: node scripts/validate-prod-env.cjs ../deploy/env/prod.env [secrets.env]
require('reflect-metadata');
const fs = require('node:fs');
const dotenv = require('dotenv');
const { validate } = require('../dist/src/config/env.validation.js');
const paths = process.argv.slice(2);
if (!paths.length) {
  console.error('Pass the deployment env file, optionally followed by a generated secrets env file.');
  process.exit(2);
}
try {
  const env = Object.assign({}, ...paths.map((path) => dotenv.parse(fs.readFileSync(path))));
  validate({ ...env, NODE_ENV: 'production', PORT: env.PORT || '3000', TYPEORM_SYNCHRONIZE: 'false' });
  console.log('Production environment validation passed (no external connections tested).');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Production environment validation failed.');
  process.exitCode = 1;
}
