import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CaptionError, decodeCaptionText, isCaptionLang, parseCaptions } from './captions.js';

const SRT = `1
00:00:01,000 --> 00:00:03,500
Welcome to <i>Power PDF</i>.

2
00:00:04,000 --> 00:00:06,000
<font color="red">Open</font> the Stamps panel
and pick a stamp.
`;

test('SRT becomes clean WebVTT', () => {
  const r = parseCaptions(Buffer.from(SRT));
  assert.equal(r.format, 'srt');
  assert.equal(r.cues, 2);
  assert.equal(r.lastCueSec, 6);
  assert.equal(r.vtt, 'WEBVTT\n\n00:00:01.000 --> 00:00:03.500\nWelcome to <i>Power PDF</i>.\n\n00:00:04.000 --> 00:00:06.000\nOpen the Stamps panel\nand pick a stamp.\n');
});

test('WebVTT keeps safe settings and drops styles, notes and markup', () => {
  const vtt = `WEBVTT - demo

STYLE
::cue { color: red }

NOTE this is a note

intro
00:01.000 --> 00:02.000 align:start position:10% onclick:evil
<v Presenter>Hello <b>there</b> & welcome <script>alert(1)</script>

00:00:03.000 --> 00:00:04.000
a --> b < c
`;
  const r = parseCaptions(vtt);
  assert.equal(r.format, 'vtt');
  assert.equal(r.cues, 2);
  assert.match(r.vtt, /00:00:01\.000 --> 00:00:02\.000 align:start position:10%\n/);
  assert.match(r.vtt, /Hello <b>there<\/b> &amp; welcome alert\(1\)/);
  assert.ok(!r.vtt.includes('STYLE') && !r.vtt.includes('NOTE') && !r.vtt.includes('<script') && !r.vtt.includes('<v '));
  assert.match(r.vtt, /a - &gt; b &lt; c/);
});

test('Windows line endings, BOM and Windows-1252 files', () => {
  const crlf = '﻿1\r\n00:00:01,000 --> 00:00:02,000\r\nCafé\r\n';
  assert.equal(parseCaptions(Buffer.from(crlf, 'utf8')).cues, 1);
  const latin = Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nCaf\xe9\n', 'latin1');
  assert.equal(decodeCaptionText(latin).includes('Café'), true);
  assert.match(parseCaptions(latin).vtt, /Café/);
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('WEBVTT\n\n00:01.000 --> 00:02.000\nHi\n', 'utf16le')]);
  assert.equal(parseCaptions(utf16).cues, 1);
});

test('bad files are refused with a helpful message', () => {
  assert.throws(() => parseCaptions('just some text'), CaptionError);
  assert.throws(() => parseCaptions('WEBVTT\n\n'), /no captions/);
  assert.throws(() => parseCaptions('1\n00:00:05,000 --> 00:00:01,000\nbackwards\n'), /timings/);
  assert.throws(() => parseCaptions(Buffer.alloc(2 * 1024 * 1024 + 1, 65)), /2 MB/);
});

test('cues are sorted and empty cues skipped', () => {
  const r = parseCaptions('1\n00:00:05,000 --> 00:00:06,000\nB\n\n2\n00:00:01,000 --> 00:00:02,000\nA\n\n3\n00:00:07,000 --> 00:00:08,000\n<i></i>\n');
  assert.equal(r.cues, 2);
  const body = r.vtt.slice('WEBVTT'.length);
  assert.ok(body.indexOf('A') < body.indexOf('B'));
});

test('language tags', () => {
  assert.ok(isCaptionLang('en'));
  assert.ok(isCaptionLang('zh-Hans'));
  assert.ok(isCaptionLang('pt-BR'));
  assert.ok(!isCaptionLang('English'));
  assert.ok(!isCaptionLang('en_US'));
  assert.ok(!isCaptionLang('../x'));
});
