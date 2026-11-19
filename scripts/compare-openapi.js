const fs = require('fs');
const { execSync } = require('child_process');

const origStr = execSync('git show HEAD:docs/openapi.json', { encoding: 'utf-8', maxBuffer: 30 * 1024 * 1024 });
const orig = JSON.parse(origStr);
const curr = JSON.parse(fs.readFileSync('docs/openapi.json', 'utf8'));

const origPaths = Object.keys(orig.paths || {});
const currPaths = Object.keys(curr.paths || {});

const added = currPaths.filter(p => !origPaths.includes(p));
const removed = origPaths.filter(p => !currPaths.includes(p));

console.log('Added paths (' + added.length + '):', added);
console.log('Removed paths (' + removed.length + '):', removed);
