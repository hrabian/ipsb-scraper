const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const CONFLICT_MARKER = /^(<<<<<<<|=======|>>>>>>>)($|\s)/m;
const TEXT_FILE_EXTENSIONS = new Set(['.js', '.json', '.md']);

function isTextFile(path) {
  return [...TEXT_FILE_EXTENSIONS].some((extension) => path.endsWith(extension));
}

test('tracked text files do not contain unresolved merge conflict markers', () => {
  const trackedFiles = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter(isTextFile);

  const filesWithMarkers = trackedFiles.filter((filePath) => (
    CONFLICT_MARKER.test(fs.readFileSync(filePath, 'utf8'))
  ));

  assert.deepEqual(filesWithMarkers, []);
});
