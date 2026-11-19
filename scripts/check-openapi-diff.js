const fs = require('fs');
const { execSync } = require('child_process');

const diff = execSync('git diff HEAD docs/openapi.json', { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });
const matches = diff.match(/^\+\s*"(\/api\/v1[^"]+)":/gm) || [];
const paths = [...new Set(matches.map(m => m.replace(/^\+\s*"/, '').replace(/":$/, '')))];
console.log('Added paths in docs/openapi.json:', JSON.stringify(paths, null, 2));
