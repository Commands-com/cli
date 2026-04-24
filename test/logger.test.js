import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommandLogger, createLogger } from '../src/logger.js';

function captureLogger(options = {}) {
  const stdout = [];
  const stderr = [];
  const logger = createLogger({
    ...options,
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
  });
  return { logger, stdout, stderr };
}

test('logger text mode writes lines, prefixed info, json, and errors', () => {
  const { logger, stdout, stderr } = captureLogger({ kind: 'review' });

  logger.line('plain output');
  logger.info('started');
  logger.json({ ok: true });
  logger.error('failed');

  assert.ok(stdout.some((line) => line === 'plain output'), 'plain line should reach stdout');
  assert.ok(stdout.some((line) => line.includes('started')), 'info message should reach stdout');
  assert.ok(stdout.some((line) => {
    try {
      return JSON.parse(line).ok === true;
    } catch {
      return false;
    }
  }), 'json payload should be parseable from stdout');
  assert.deepEqual(stderr, ['failed']);
});

test('logger json mode suppresses text output but still writes json and errors', () => {
  const { logger, stdout, stderr } = captureLogger({ json: true, kind: 'quality' });

  logger.line('plain output');
  logger.info('started');
  logger.json({ type: 'quality.completed' });
  logger.error('failed');

  assert.equal(logger.jsonMode, true);
  assert.ok(!stdout.some((line) => line.includes('plain output')), 'json mode should silence plain lines');
  assert.ok(!stdout.some((line) => line.includes('started')), 'json mode should silence info messages');
  assert.ok(stdout.some((line) => {
    try {
      return JSON.parse(line).type === 'quality.completed';
    } catch {
      return false;
    }
  }), 'json payload should be parseable from stdout');
  assert.deepEqual(stderr, ['failed']);
});

test('child loggers inherit output streams and json mode with the child kind', () => {
  const stdout = [];
  const stderr = [];
  const parent = createLogger({
    json: true,
    kind: 'parent',
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
  });
  const child = parent.child('child');

  child.info('hidden');
  child.json({ child: true });
  child.error('child error');

  assert.equal(child.kind, 'child');
  assert.equal(child.jsonMode, true);
  assert.ok(!stdout.some((line) => line.includes('hidden')), 'json mode child should silence info');
  assert.ok(stdout.some((line) => {
    try {
      return JSON.parse(line).child === true;
    } catch {
      return false;
    }
  }), 'child json payload should reach stdout');
  assert.deepEqual(stderr, ['child error']);
});

test('createCommandLogger enables json mode from parsed flags', () => {
  const jsonLogger = createCommandLogger({ flags: new Map([['json', 'true']]) });
  const textLogger = createCommandLogger({ flags: new Map() });

  assert.equal(jsonLogger.jsonMode, true);
  assert.equal(textLogger.jsonMode, false);
});
