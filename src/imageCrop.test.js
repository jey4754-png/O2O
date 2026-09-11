import test from 'node:test';
import assert from 'node:assert/strict';

import {
  encodeCanvasJpegWithinLimit,
  normalizeImageCrop,
  squareCropRect,
} from './imageCrop.js';

test('image crop defaults to the centered square without keeping a full screenshot', () => {
  assert.deepEqual(squareCropRect(1200, 800), {
    x: 200,
    y: 0,
    width: 800,
    height: 800,
  });
  assert.deepEqual(squareCropRect(600, 1200), {
    x: 0,
    y: 300,
    width: 600,
    height: 600,
  });
});

test('image crop zoom and position stay inside source bounds', () => {
  assert.deepEqual(squareCropRect(1200, 800, { zoom: 2, offsetX: 100, offsetY: -100 }), {
    x: 800,
    y: 0,
    width: 400,
    height: 400,
  });
  assert.deepEqual(normalizeImageCrop({ zoom: 9, offsetX: -900, offsetY: 900 }), {
    zoom: 3,
    offsetX: -100,
    offsetY: 100,
  });
});

test('jpeg encoding keeps the current resolution and lowers quality before resizing', () => {
  const qualities = [];
  const canvas = {
    toDataURL(_type, quality) {
      qualities.push(quality);
      return `data:image/jpeg;base64,${'a'.repeat(quality > 0.61 ? 120 : 40)}`;
    },
  };

  const output = encodeCanvasJpegWithinLimit(canvas, {
    quality: 0.82,
    minQuality: 0.46,
    maxDataUrlLength: 80,
  });

  assert.ok(output.length <= 80);
  assert.equal(qualities[0], 0.82);
  assert.equal(qualities[1], 0.46);
  assert.ok(qualities.length > 2);
});
