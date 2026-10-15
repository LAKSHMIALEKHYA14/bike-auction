const { EventEmitter } = require('events');
class BidError extends Error { constructor(code, msg, status = 409) { super(msg); this.code = code; this.status = status; } }
const SNIPE_MS = 60_000; // bids in the last minute extend the auction by a minute

// Domain service: all auction rules live here, independent of HTTP/WebSocket.
// Node's single-threaded event loop makes placeBid atomic per process; with multiple
// instances, move state to Postgres and use SELECT ... FOR UPDATE (see README).
class AuctionService extends EventEmitter {
  constructor() { super(); this.items = new Map(); this.seq = 0; }
  create(i) {
    const a = { id: String(++this.seq), title: i.title, description: i.description || '', startPrice: i.startPrice,
      minIncrement: i.minIncrement, startsAt: i.startsAt, endsAt: i.endsAt, currentPrice: i.startPrice, leaderId: null, bids: [], closed: false };
    this.items.set(a.id, a); this.emit('event', { type: 'created', auction: this.view(a) }); return this.view(a);
  }
  status(a, now = Date.now()) { return a.closed || now >= a.endsAt ? 'ended' : now < a.startsAt ? 'scheduled' : 'live'; }
  view(a, now = Date.now()) {
    const { bids, leaderId, ...r } = a;
    return { ...r, status: this.status(a, now), bidCount: bids.length, recent: bids.slice(-5).reverse().map(b => ({ bidder: b.bidder, amount: b.amount, at: b.at })) };
  }
  list(now) { return [...this.items.values()].map(a => this.view(a, now)); }
  find(id) { const a = this.items.get(id); if (!a) throw new BidError('NOT_FOUND', 'Auction not found', 404); return a; }
  get(id, now) { return this.view(this.find(id), now); }
  placeBid(id, user, amount, now = Date.now()) {
    const a = this.find(id), s = this.status(a, now);
    if (s === 'scheduled') throw new BidError('NOT_STARTED', 'Auction has not started');
    if (s === 'ended') throw new BidError('ENDED', 'Auction has ended');
    if (a.leaderId === user.id) throw new BidError('ALREADY_LEADING', 'You are already the highest bidder');
    const min = a.bids.length ? a.currentPrice + a.minIncrement : a.startPrice;
    if (amount < min) throw new BidError('BID_TOO_LOW', `Minimum bid is ${min}`);
    a.currentPrice = amount; a.leaderId = user.id;
    a.bids.push({ userId: user.id, bidder: user.email.replace(/^(.).*(@.*)$/, '$1***$2'), amount, at: now });
    if (a.endsAt - now <= SNIPE_MS) a.endsAt += SNIPE_MS;
    const v = this.view(a, now); this.emit('event', { type: 'bid', auction: v }); return v;
  }
  cancel(id) { const a = this.find(id); a.closed = true; const v = this.view(a); this.emit('event', { type: 'ended', auction: v, winner: null }); return v; }
  sweep(now = Date.now()) { // closes expired auctions exactly once and announces winners
    for (const a of this.items.values()) if (!a.closed && now >= a.endsAt) {
      a.closed = true; this.emit('event', { type: 'ended', auction: this.view(a, now), winner: a.leaderId ? a.bids.at(-1).bidder : null });
    }
  }
}
module.exports = { AuctionService, BidError };
