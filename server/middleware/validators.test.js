/**
 * Unit tests for the shared field-sanitization validator chain factory
 * (Requirement 5.7).
 *
 * These tests exercise `textField(maxLen)` by mounting it in a minimal
 * Express app and asserting the resulting request body has been trimmed
 * and HTML-escaped, and that `isLength` correctly enforces the configured
 * maximum length via express-validator's `validationResult`.
 */

const express = require('express');
const request = require('supertest');
const { validationResult } = require('express-validator');
const { textField } = require('./validators');

function buildApp(chain) {
  const app = express();
  app.use(express.json());
  app.post('/test', chain, (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    return res.status(200).json({ value: req.body.value });
  });
  return app;
}

describe('textField', () => {
  it('is a function that returns a chain factory', () => {
    expect(typeof textField).toBe('function');
    const factory = textField();
    expect(typeof factory).toBe('function');
  });

  it('trims leading/trailing whitespace from the field value', async () => {
    const app = buildApp([textField()('value')]);
    const res = await request(app).post('/test').send({ value: '  hello world  ' });
    expect(res.status).toBe(200);
    expect(res.body.value).toBe('hello world');
  });

  it('HTML-escapes characters significant to HTML rendering', async () => {
    const app = buildApp([textField()('value')]);
    const res = await request(app)
      .post('/test')
      .send({ value: '<script>alert(1)</script>' });
    expect(res.status).toBe(200);
    expect(res.body.value).not.toContain('<script>');
    expect(res.body.value).toBe(
      '&lt;script&gt;alert(1)&lt;&#x2F;script&gt;'
    );
  });

  it('defaults the maximum length to 1000 characters', async () => {
    const app = buildApp([textField()('value')]);
    const withinLimit = 'a'.repeat(1000);
    const overLimit = 'a'.repeat(1001);

    const okRes = await request(app).post('/test').send({ value: withinLimit });
    expect(okRes.status).toBe(200);

    const failRes = await request(app).post('/test').send({ value: overLimit });
    expect(failRes.status).toBe(400);
    expect(failRes.body.errors.some((e) => e.path === 'value')).toBe(true);
  });

  it('enforces a stricter, caller-supplied maximum length', async () => {
    const app = buildApp([textField(5)('value')]);

    const okRes = await request(app).post('/test').send({ value: 'abcde' });
    expect(okRes.status).toBe(200);

    const failRes = await request(app).post('/test').send({ value: 'abcdef' });
    expect(failRes.status).toBe(400);
    expect(failRes.body.errors.some((e) => e.path === 'value')).toBe(true);
  });

  it('rejects a value exceeding the max length even after trimming', async () => {
    const app = buildApp([textField(5)('value')]);
    const res = await request(app).post('/test').send({ value: '   abcdef   ' });
    expect(res.status).toBe(400);
  });

  it('produces independent chains for different field names', async () => {
    const chain = textField(3);
    const app = express();
    app.use(express.json());
    app.post('/multi', [chain('a'), chain('b')], (req, res) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      return res.status(200).json({ a: req.body.a, b: req.body.b });
    });

    const okRes = await request(app).post('/multi').send({ a: 'ab', b: 'cd' });
    expect(okRes.status).toBe(200);

    const failRes = await request(app).post('/multi').send({ a: 'abcd', b: 'cd' });
    expect(failRes.status).toBe(400);
    expect(failRes.body.errors.some((e) => e.path === 'a')).toBe(true);
    expect(failRes.body.errors.some((e) => e.path === 'b')).toBe(false);
  });
});
