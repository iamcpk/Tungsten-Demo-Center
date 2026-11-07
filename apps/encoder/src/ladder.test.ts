import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evenWidth, masterPlaylist, pickLadder } from './ladder.js';

test('never upscales', () => {
  assert.deepEqual(pickLadder(1080).map((r) => r.name), ['1080p', '720p', '480p']);
  assert.deepEqual(pickLadder(720).map((r) => r.name), ['720p', '480p']);
  assert.deepEqual(pickLadder(1084).map((r) => r.name), ['1080p', '720p', '480p']);
  assert.deepEqual(pickLadder(361).map((r) => r.height), [360]);
});

test('widths are even and keep aspect ratio', () => {
  assert.equal(evenWidth(1920, 1080, 720), 1280);
  assert.equal(evenWidth(1366, 768, 480) % 2, 0);
});

test('master playlist lists variants', () => {
  const m = masterPlaylist([{ r: pickLadder(720)[0]!, width: 1280, hasAudio: true }]);
  assert.match(m, /RESOLUTION=1280x720/);
  assert.match(m, /720p\/index\.m3u8/);
});
