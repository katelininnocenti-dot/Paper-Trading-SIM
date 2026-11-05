const assert = require('assert');
const M = require('../lib-market');
const { dueLiveJobs } = require('../lib-schedule');
const { starterPositions } = require('../lib-seed');
const db = require('../lib-db');

const keys = (clock) => dueLiveJobs(clock, M).map((job) => `${job.date}:${job.key}`);

assert.deepStrictEqual(keys({ date: '2026-11-05', mins: 6 * 60 + 50 }), ['2026-11-04:close']);
assert.deepStrictEqual(keys({ date: '2026-11-05', mins: 7 * 60 + 10 }), ['2026-11-05:daily_check', '2026-11-04:close']);
assert.deepStrictEqual(keys({ date: '2026-11-05', mins: 8 * 60 + 10 }), ['2026-11-05:daily_check', '2026-11-05:game_plan', '2026-11-04:close']);
assert.deepStrictEqual(keys({ date: '2026-11-05', mins: 8 * 60 + 30 }), ['2026-11-05:daily_check', '2026-11-05:game_plan']);
assert.deepStrictEqual(keys({ date: '2026-11-05', mins: 15 * 60 }), ['2026-11-05:daily_check', '2026-11-05:game_plan', '2026-11-05:close']);
assert.deepStrictEqual(keys({ date: '2026-11-07', mins: 10 * 60 }), ['2026-11-06:close']);
assert.deepStrictEqual(keys({ date: '2026-11-27', mins: 11 * 60 + 59 }), ['2026-11-27:daily_check', '2026-11-27:game_plan']);
assert.ok(keys({ date: '2026-11-27', mins: 12 * 60 }).includes('2026-11-27:close'));

const plan = starterPositions({ MRK: { price: 80 }, CVX: { price: 150 }, MDLZ: { price: 70 } }, ['MRK', 'CVX', 'MDLZ'], 500);
assert.strictEqual(plan.positions.MRK.shares, 2);
assert.strictEqual(plan.positions.CVX.shares, 1);
assert.strictEqual(plan.positions.MDLZ.shares, 2);
const spent = Object.values(plan.positions).reduce((sum, position) => sum + position.cost, 0);
assert.ok(Math.abs(spent + plan.cash - 500) < 0.001);
assert.ok(plan.cash >= 0);

const pricey = starterPositions({ MRK: { price: 400 }, CVX: { price: 400 }, MDLZ: { price: 10 } }, ['MRK', 'CVX', 'MDLZ'], 500);
assert.strictEqual(pricey.positions.MRK.shares, 1);
assert.ok(!pricey.positions.CVX);
assert.strictEqual(pricey.positions.MDLZ.shares, 10);
assert.strictEqual(pricey.cash, 0);

const tables = ['accounts', 'positions', 'orders', 'fills', 'snapshots', 'messages', 'emails', 'push_subscriptions', 'job_markers', 'app_config'];
for (const table of tables) assert.ok(db.SCHEMA.includes(`CREATE TABLE IF NOT EXISTS ${table}`), table);
assert.ok(db.schemaStatements().length >= tables.length);

require('../lib-quotes');
require('../server');

console.log('smoke ok', db.schemaStatements().length, 'schema statements');
