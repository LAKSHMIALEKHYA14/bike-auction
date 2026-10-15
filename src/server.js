const http = require('http'), { WebSocketServer } = require('ws'), { createApp } = require('./app');
const admin = { email: process.env.ADMIN_EMAIL || 'admin@bikes.test', password: process.env.ADMIN_PASSWORD || 'Admin#12345' };
const { app, svc, addUser } = createApp({ secret: process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? undefined : 'dev-secret'), admin });
if (process.env.SEED !== '0') { // demo data + demo buyer
  addUser('buyer@bikes.test', 'Buyer#12345', 'user'); const n = Date.now(), h = 3600_000;
  [['2019 Royal Enfield Classic 350', 120000], ['2021 KTM Duke 200', 150000], ['2018 Yamaha R15 V3', 110000]].forEach(([t, p], i) =>
    svc.create({ title: t, description: 'Single owner, service history available.', startPrice: p, minIncrement: 1000, startsAt: n - 1000, endsAt: n + (i + 1) * h }));
}
const server = http.createServer(app), wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 });
svc.on('event', e => wss.clients.forEach(c => c.readyState === 1 && c.send(JSON.stringify(e))));
const beat = setInterval(() => wss.clients.forEach(c => { if (c.dead) return c.terminate(); c.dead = true; c.ping(); }), 30000);
wss.on('connection', c => { c.dead = false; c.on('pong', () => (c.dead = false)); });
const sweeper = setInterval(() => svc.sweep(), 1000);
server.listen(process.env.PORT || 3000, () => console.log(JSON.stringify({ level: 'info', msg: 'listening', port: server.address().port })));
process.on('SIGTERM', () => { clearInterval(sweeper); clearInterval(beat); wss.close(); server.close(() => process.exit(0)); });
