'use strict';
const { defineConfig } = require('vitest/config');

module.exports = defineConfig({
  test: {
    include: ['test/**/*.spec.js'],
    environment: 'node',
    testTimeout: 30000, // fuzz tests with 50k-element arrays / 1M-char strings need headroom
    reporters: ['default'],
  },
});
