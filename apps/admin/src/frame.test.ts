import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SAFE_REL, findSegment, joinRel, pickVariant } from './frame.js';

const MASTER = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-STREAM-INF:BANDWIDTH=5628000,RESOLUTION=1920x1080,CODECS="avc1.4d401f,mp4a.40.2"
1080p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3208000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
720p/index.m3u8
`;
const MEDIA = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXTINF:6.000000,
seg_00000.ts
#EXTINF:6.000000,
seg_00001.ts
#EXTINF:2.500000,
seg_00002.ts
#EXT-X-ENDLIST
`;

test('picks the highest rendition', () => {
  assert.equal(pickVariant(MASTER), '1080p/index.m3u8');
  assert.equal(pickVariant(MASTER.replace('1920x1080', '640x360')), '720p/index.m3u8');
  assert.equal(pickVariant('#EXTM3U\n'), undefined);
});

test('finds the segment and offset for a time', () => {
  assert.deepEqual(findSegment(MEDIA, 0), { uri: 'seg_00000.ts', offset: 0 });
  assert.deepEqual(findSegment(MEDIA, 7.5), { uri: 'seg_00001.ts', offset: 1.5 });
  assert.equal(findSegment(MEDIA, 13)!.uri, 'seg_00002.ts');
  assert.equal(findSegment(MEDIA, 99)!.uri, 'seg_00002.ts', 'past the end gives the last frame');
  assert.equal(findSegment('#EXTM3U\n', 1), undefined);
});

test('only plain relative paths are followed', () => {
  assert.ok(SAFE_REL.test('1080p/index.m3u8'));
  assert.ok(SAFE_REL.test('seg_00001.ts'));
  assert.ok(!SAFE_REL.test('../other/index.m3u8'));
  assert.ok(!SAFE_REL.test('https://evil.example/x.ts'));
  assert.ok(!SAFE_REL.test('/abs/x.ts'));
  assert.equal(joinRel('hls/a/b/master.m3u8', '1080p/index.m3u8'), 'hls/a/b/1080p/index.m3u8');
});
