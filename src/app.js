const express = require('express'), helmet = require('helmet'), rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken'), { z } = require('zod'), crypto = require('crypto'), path = require('path');
const { AuctionService, BidError } = require('./auction');

function createApp({ secret = process.env.JWT_SECRET, admin, log = (o) => console.log(JSON.stringify(o)) } = {}) {
  if (!secret) throw new Error('JWT_SECRET is required');
  const svc = new AuctionService(), users = new Map(), m = { http_requests_total: 0, bids_accepted_total: 0, bids_rejected_total: 0 };
  const addUser = (email, password, role) => { const u = { id: crypto.randomUUID(), email, role, hash: bcrypt.hashSync(password, 10) }; users.set(email, u); return u; };
  if (admin) addUser(admin.email, admin.password, 'admin');
  svc.on('event', e => { if (e.type === 'bid') m.bids_accepted_total++; });

  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], connectSrc: ["'self'", 'ws:', 'wss:'], styleSrc: ["'self'", "'unsafe-inline'"], scriptSrc: ["'self'", "'unsafe-inline'"], scriptSrcAttr: ["'unsafe-inline'"] } } }));
  app.use(express.json({ limit: '10kb' }));
  app.use((req, res, next) => { // request id + structured access log
    const t = process.hrtime.bigint(); req.id = crypto.randomUUID(); res.setHeader('x-request-id', req.id); m.http_requests_total++;
    res.on('finish', () => log({ level: 'info', msg: 'http', id: req.id, method: req.method, path: req.path, status: res.statusCode, ms: Number(process.hrtime.bigint() - t) / 1e6 }));
    next();
  });
  app.use('/api', rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true }));
  const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 50 });

  const auth = (role) => (req, res, next) => {
    try { const u = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), secret); if (role && u.role !== role) return res.status(403).json({ error: 'FORBIDDEN' }); req.user = u; next(); }
    catch { res.status(401).json({ error: 'UNAUTHORIZED' }); }
  };
  const token = u => jwt.sign({ id: u.id, email: u.email, role: u.role }, secret, { expiresIn: '1h' });
  const cred = z.object({ email: z.string().email().max(120), password: z.string().min(8).max(100) });

  app.post('/api/auth/register', authLimiter, (req, res) => {
    const { email, password } = cred.parse(req.body);
    if (users.has(email)) return res.status(409).json({ error: 'EMAIL_TAKEN' });
    const u = addUser(email, password, 'user'); res.status(201).json({ token: token(u), role: u.role });
  });
  app.post('/api/auth/login', authLimiter, (req, res) => {
    const { email, password } = cred.parse(req.body); const u = users.get(email);
    if (!u || !bcrypt.compareSync(password, u.hash)) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
    res.json({ token: token(u), role: u.role });
  });
  app.get('/api/auctions', (req, res) => res.json(svc.list()));
  app.get('/api/auctions/:id', (req, res) => res.json(svc.get(req.params.id)));
  const newAuction = z.object({ title: z.string().min(3).max(120), description: z.string().max(1000).optional(), startPrice: z.number().int().positive(),
    minIncrement: z.number().int().positive(), startsAt: z.number().int(), endsAt: z.number().int() }).refine(a => a.endsAt > a.startsAt, 'endsAt must be after startsAt');
  app.post('/api/auctions', auth('admin'), (req, res) => res.status(201).json(svc.create(newAuction.parse(req.body))));
  app.delete('/api/auctions/:id', auth('admin'), (req, res) => res.json(svc.cancel(req.params.id)));
  app.post('/api/auctions/:id/bids', auth(), (req, res) => {
    const { amount } = z.object({ amount: z.number().int().positive() }).parse(req.body);
    try { res.status(201).json(svc.placeBid(req.params.id, req.user, amount)); } catch (e) { if (e instanceof BidError) m.bids_rejected_total++; throw e; }
  });
  app.get('/healthz', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
  app.get('/metrics', (req, res) => res.type('text/plain').send(Object.entries(m).map(([k, v]) => `${k} ${v}`).join('\n') + '\n'));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.use((err, req, res, next) => {
    if (err instanceof BidError) return res.status(err.status).json({ error: err.code, message: err.message });
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'VALIDATION', details: err.issues.map(i => `${i.path.join('.')}: ${i.message}`) });
    log({ level: 'error', msg: err.message, id: req.id }); res.status(500).json({ error: 'INTERNAL', id: req.id });
  });
  return { app, svc, addUser };
}
module.exports = { createApp };
