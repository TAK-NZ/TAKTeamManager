const request = require('supertest');
const express = require('express');

jest.mock('../config/database', () => ({ query: jest.fn(), connect: jest.fn() }));

const joinRouter = require('./join');

function buildApp() {
  const app = express();
  app.use('/join', joinRouter);
  return app;
}

describe('GET /join/:code (short sign-up link)', () => {
  const app = buildApp();

  it('redirects a valid code to the canonical request-access URL', async () => {
    const res = await request(app).get('/join/4KP7NXRM');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/request-access?code=4KP7NXRM');
  });

  it('accepts lowercase and the optional dash, normalising to the raw uppercase code', async () => {
    const res = await request(app).get('/join/4kp7-nxrm');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/request-access?code=4KP7NXRM');
  });

  it.each([
    ['too short', 'ABC'],
    ['too long', '4KP7NXRMZ'],
    ['ambiguous characters (0, O, 1, I, L)', '0O1ILABC'],
    ['dash in the wrong place', '4KP-7NXRM'],
    ['markup', '%3Cscript%3E'],
    ['an absolute URL', 'https%3A%2F%2Fevil.example.com']
  ])('redirects %s to the sign-up page without a code', async (_label, input) => {
    const res = await request(app).get(`/join/${input}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/request-access');
  });

  it('never reflects the Host header into the Location', async () => {
    const res = await request(app).get('/join/4KP7NXRM').set('Host', 'evil.example.com');
    expect(res.headers.location).toBe('/request-access?code=4KP7NXRM');
  });

  it('does not require authentication', async () => {
    const res = await request(app).get('/join/4KP7NXRM');
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
