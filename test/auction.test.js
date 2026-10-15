const test = require('node:test'), assert = require('node:assert'), { AuctionService } = require('../src/auction'), { createApp } = require('../src/app');
const mk = (s) => s.create({ title: 'Bike', startPrice: 100, minIncrement: 10, startsAt: 0, endsAt: 1_000_000 });
const u = (id) => ({ id, email: `${id}@x.com` });

test('enforces start price, increment, and no self-outbid', () => {
  const s = new AuctionService(), a = mk(s);
  assert.throws(() => s.placeBid(a.id, u('a'), 50, 10), { code: 'BID_TOO_LOW' });
  s.placeBid(a.id, u('a'), 100, 10);
  assert.throws(() => s.placeBid(a.id, u('a'), 200, 10), { code: 'ALREADY_LEADING' });
  assert.throws(() => s.placeBid(a.id, u('b'), 105, 10), { code: 'BID_TOO_LOW' });
  assert.strictEqual(s.placeBid(a.id, u('b'), 110, 10).currentPrice, 110);
});
test('anti-sniping extends; sweep closes once; late bids rejected', () => {
  const s = new AuctionService(), a = mk(s), ended = []; s.on('event', e => e.type === 'ended' && ended.push(e));
  assert.strictEqual(s.placeBid(a.id, u('a'), 100, 999_999).endsAt, 1_060_000);
  s.sweep(1_100_000); s.sweep(1_200_000);
  assert.strictEqual(ended.length, 1);
  assert.throws(() => s.placeBid(a.id, u('b'), 500, 1_100_000), { code: 'ENDED' });
});
test('HTTP: auth, RBAC, validation, bidding', async () => {
  const { app } = createApp({ secret: 's', admin: { email: 'ad@x.com', password: 'password1' }, log: () => {} });
  const srv = app.listen(0), base = `http://localhost:${srv.address().port}/api`;
  const call = async (p, method = 'GET', body, tok) => { const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(tok && { authorization: 'Bearer ' + tok }) }, body: body && JSON.stringify(body) }); return [r.status, await r.json()]; };
  try {
    const [, user] = await call('/auth/register', 'POST', { email: 'u@x.com', password: 'password1' });
    const [, adm] = await call('/auth/login', 'POST', { email: 'ad@x.com', password: 'password1' });
    const body = { title: 'Bike 1', startPrice: 100, minIncrement: 10, startsAt: Date.now() - 1, endsAt: Date.now() + 600000 };
    assert.strictEqual((await call('/auctions', 'POST', body, user.token))[0], 403);
    const [c, a] = await call('/auctions', 'POST', body, adm.token); assert.strictEqual(c, 201);
    assert.strictEqual((await call(`/auctions/${a.id}/bids`, 'POST', { amount: 100 }))[0], 401);
    assert.strictEqual((await call(`/auctions/${a.id}/bids`, 'POST', { amount: 100 }, user.token))[0], 201);
    assert.strictEqual((await call(`/auctions/${a.id}/bids`, 'POST', { amount: 'x' }, adm.token))[0], 400);
    assert.strictEqual((await call('/auth/login', 'POST', { email: 'u@x.com', password: 'wrongpass' }))[0], 401);
  } finally { srv.close(); }
});
