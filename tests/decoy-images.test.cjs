'use strict';
/*
 * B5 - decoy images + surface-wide image watermarking.
 *
 * Pins: the registry's image family (validation, surface
 * normalization, spec declaration, DEC-3 tool parity), the
 * deterministic grayscale PNG encoder, and the surface's
 * image serving - plain serves byte-identical whether the
 * watermark option is absent or off, and with the option on,
 * EVERY served image (hero 720x360 and banner 480x320, the
 * two classes VID-TRACE measured) decodes to the requesting
 * identity's AC-23 payload in full.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const sdk = require('../dist/index.js');
const tool = require('../tools/decoy/decoy.cjs');
const { REGISTRY, req } = require('./fixtures/decoy-registry.cjs');

const SECRET = 'b5-test-secret';

/** Deterministic textured luminance plane (no fixture files needed). */
function makePlane(width, height) {
  const y = new Array(width * height);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      y[row * width + col] = (col * 7 + row * 13 + ((col * row) % 29)) % 256;
    }
  }
  return y;
}

const HERO = { path: '/img/hero.png', width: 720, height: 360, y: makePlane(720, 360), summary: 'Catalog hero' };
const BANNER = { path: '/img/banner.png', width: 480, height: 320, y: makePlane(480, 320) };
const REGISTRY_IMG = { ...REGISTRY, images: [HERO, BANNER] };

/** Decode a grayscale PNG produced by the SDK encoder back to its luminance plane. */
function decodePngPlane(bodyBytes) {
  const bytes = Buffer.from(bodyBytes);
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'PNG signature');
  let off = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (off < bytes.length) {
    const len = bytes.readUInt32BE(off);
    const type = bytes.toString('ascii', off + 4, off + 8);
    const data = bytes.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[8], 8, 'bit depth 8');
      assert.equal(data[9], 0, 'color type 0 (grayscale)');
    }
    if (type === 'IDAT') idat.push(Buffer.from(data));
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const y = new Uint8Array(width * height);
  for (let row = 0; row < height; row++) {
    assert.equal(raw[row * (width + 1)], 0, 'filterless scanlines');
    y.set(raw.subarray(row * (width + 1) + 1, row * (width + 1) + 1 + width), row * width);
  }
  return { width, height, y };
}

test('registry validation accepts declared images (including in the discovery sets) and rejects broken ones', () => {
  assert.deepEqual(sdk.validateDecoyRegistry(REGISTRY_IMG), []);
  const withDiscovery = {
    ...REGISTRY_IMG,
    discovery: { ...REGISTRY.discovery, sitemapPaths: [...REGISTRY.discovery.sitemapPaths, '/img/hero.png'] },
  };
  assert.deepEqual(sdk.validateDecoyRegistry(withDiscovery), [], 'an image path is a declared decoy path for discovery');

  const dup = { ...REGISTRY, images: [HERO, HERO] };
  assert.ok(sdk.validateDecoyRegistry(dup).some((e) => e.includes('duplicate image path')));
  const collideEndpoint = { ...REGISTRY, images: [{ ...HERO, path: '/api/v2/products' }] };
  assert.ok(sdk.validateDecoyRegistry(collideEndpoint).some((e) => e.includes('collides')));
  const collideSpec = { ...REGISTRY, images: [{ ...HERO, path: '/openapi.json' }] };
  assert.ok(sdk.validateDecoyRegistry(collideSpec).some((e) => e.includes('generated document path')));
  const badPlane = { ...REGISTRY, images: [{ path: '/img/x.png', width: 16, height: 16, y: [1, 2, 3] }] };
  assert.ok(sdk.validateDecoyRegistry(badPlane).some((e) => e.includes('plane length')));
  const badValue = { ...REGISTRY, images: [{ path: '/img/x.png', width: 2, height: 2, y: [0, 64, 128, 999] }] };
  assert.ok(sdk.validateDecoyRegistry(badValue).some((e) => e.includes('[0, 255]')));
});

test('the generated surface carries images, owns their paths, and the spec declares them (tool parity included)', () => {
  const surface = sdk.generateDecoySurface(REGISTRY_IMG);
  assert.equal(surface.images.length, 2);
  const paths = sdk.decoySurfacePaths(surface);
  assert.ok(paths.includes('/img/hero.png') && paths.includes('/img/banner.png'));
  const spec = sdk.buildDecoyOpenApiSpec(surface);
  assert.equal(spec.paths['/img/hero.png'].get.summary, 'Catalog hero');
  assert.equal(spec.paths['/img/banner.png'].get.summary, 'Decoy image');

  const toolSurface = tool.generateSurface(REGISTRY_IMG);
  assert.equal(toolSurface.images.length, 2);
  assert.deepEqual(tool.buildSpec(toolSurface), spec, 'DEC-3: the build-time tool renders the same spec, images included');
});

test('the PNG encoder round-trips a plane exactly and is deterministic', () => {
  const plane = { width: 16, height: 16, y: makePlane(16, 16) };
  const a = sdk.encodeGrayscalePng(plane);
  const b = sdk.encodeGrayscalePng(plane);
  assert.deepEqual(Buffer.from(a), Buffer.from(b), 'same plane, same bytes');
  const back = decodePngPlane(a);
  assert.equal(back.width, 16);
  assert.equal(back.height, 16);
  assert.deepEqual([...back.y], plane.y, 'PNG is lossless: the decoded plane is the declared plane');
  assert.throws(() => sdk.encodeGrayscalePng({ width: 16, height: 16, y: [1, 2] }), sdk.DecoyImagesError);
});

test('watermark capacity follows the AC-23 block law', () => {
  assert.equal(sdk.decoyImageCarriesAc23(720, 360), true, 'hero class');
  assert.equal(sdk.decoyImageCarriesAc23(480, 320), true, 'banner class');
  assert.equal(sdk.decoyImageCarriesAc23(64, 64), false, 'too few blocks');
  assert.equal(sdk.decoyImageCarriesAc23(100, 100), false, 'not a multiple of 8');
});

test('a disabled surface does not handle image paths, whatever the options', async () => {
  const surface = sdk.generateDecoySurface(REGISTRY_IMG);
  const off = sdk.createDecoySurface({ surface, watermarkImages: true, watermarkSecret: SECRET });
  assert.equal(off.enabled, false);
  assert.equal((await off.handle(req('/img/hero.png'))).handled, false);
});

test('plain image serves are byte-identical with the watermark option absent or off', async () => {
  const surface = sdk.generateDecoySurface(REGISTRY_IMG);
  const bare = sdk.createDecoySurface({ enabled: true, surface, joinSecret: 'surface-test-secret' });
  const off = sdk.createDecoySurface({ enabled: true, surface, joinSecret: 'surface-test-secret', watermarkImages: false, watermarkSecret: SECRET });
  assert.ok(bare.paths.includes('/img/hero.png'));
  for (const p of ['/img/hero.png', '/img/banner.png']) {
    const a = await bare.handle(req(p));
    const b = await off.handle(req(p));
    assert.equal(a.status, 200);
    assert.equal(a.contentType, 'image/png');
    assert.equal(a.body, '');
    assert.deepEqual(Buffer.from(a.bodyBytes), Buffer.from(b.bodyBytes), `${p}: option off serves exactly the option-absent bytes`);
    const plane = decodePngPlane(a.bodyBytes);
    const declared = p === '/img/hero.png' ? HERO : BANNER;
    assert.deepEqual([...plane.y], declared.y, `${p}: the unwatermarked serve is the declared plane, untouched`);
  }
  const spec = JSON.parse((await bare.handle(req('/openapi.json'))).body);
  assert.ok(spec.paths['/img/hero.png'], 'the served spec declares the image');
  const docs = await bare.handle(req('/api-docs'));
  assert.ok(docs.body.includes('/img/hero.png'), 'the docs page lists the image');
});

test('watermarking fails fast at construction: no secret, or an image too small to carry the payload', () => {
  const surface = sdk.generateDecoySurface(REGISTRY_IMG);
  assert.throws(
    () => sdk.createDecoySurface({ enabled: true, surface, joinSecret: 's', watermarkImages: true }),
    sdk.DecoySurfaceError,
    'watermarkImages without a secret',
  );
  const small = { path: '/img/small.png', width: 64, height: 64, y: makePlane(64, 64) };
  const smallSurface = sdk.generateDecoySurface({ ...REGISTRY, images: [small] });
  assert.throws(
    () => sdk.createDecoySurface({ enabled: true, surface: smallSurface, joinSecret: 's', watermarkImages: true, watermarkSecret: SECRET }),
    (err) => err instanceof sdk.DecoySurfaceError && err.message.includes('/img/small.png'),
    'a 64x64 image cannot carry 32 x 48 blocks',
  );
});

test('a too-small image still serves plainly when watermarking is off', async () => {
  const small = { path: '/img/small.png', width: 64, height: 64, y: makePlane(64, 64) };
  const surface = sdk.generateDecoySurface({ ...REGISTRY, images: [small] });
  const h = sdk.createDecoySurface({ enabled: true, surface, joinSecret: 's' });
  const r = await h.handle(req('/img/small.png'));
  assert.equal(r.status, 200);
  assert.deepEqual([...decodePngPlane(r.bodyBytes).y], small.y);
});

test('watermark ON: EVERY served image decodes in full to the requesting identity (the VID-TRACE P-VT2 shape)', async () => {
  const surface = sdk.generateDecoySurface(REGISTRY_IMG);
  const h = sdk.createDecoySurface({
    enabled: true, surface, joinSecret: 'surface-test-secret',
    watermarkImages: true, watermarkSecret: SECRET,
  });
  const a = { 'x-identity': 'recorder-a' };
  const b = { 'x-identity': 'recorder-b' };
  for (const p of ['/img/hero.png', '/img/banner.png']) {
    const serveA = await h.handle(req(p, a));
    const planeA = decodePngPlane(serveA.bodyBytes);
    const forA = sdk.extractYDctWatermarkForIdentity(planeA, SECRET, 'recorder-a');
    assert.equal(forA.fullMatch, true, `${p}: full 32/32 match for the served identity`);
    assert.equal(forA.correctBits, 32);
    const againstB = sdk.extractYDctWatermarkForIdentity(planeA, SECRET, 'recorder-b');
    assert.equal(againstB.fullMatch, false, `${p}: identity A's image does not attribute to B`);

    const serveB = await h.handle(req(p, b));
    assert.notDeepEqual(Buffer.from(serveB.bodyBytes), Buffer.from(serveA.bodyBytes), `${p}: per-identity serves differ`);
    assert.equal(sdk.extractYDctWatermarkForIdentity(decodePngPlane(serveB.bodyBytes), SECRET, 'recorder-b').fullMatch, true);

    const serveA2 = await h.handle(req(p, a));
    assert.deepEqual(Buffer.from(serveA2.bodyBytes), Buffer.from(serveA.bodyBytes), `${p}: deterministic per identity`);
  }
  assert.deepEqual(HERO.y, makePlane(720, 360), 'the declared plane is never mutated by watermarked serves');
});

test('HEAD on an image path returns headers only', async () => {
  const surface = sdk.generateDecoySurface(REGISTRY_IMG);
  const h = sdk.createDecoySurface({ enabled: true, surface, joinSecret: 's', watermarkImages: true, watermarkSecret: SECRET });
  const r = await h.handle(req('/img/hero.png', {}, 'HEAD'));
  assert.equal(r.status, 200);
  assert.equal(r.contentType, 'image/png');
  assert.equal(r.bodyBytes.length, 0);
});
