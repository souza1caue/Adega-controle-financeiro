import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import worker from '../src/worker.js';

// Execute the production SQL with SQLite and D1-style transactional batches.
export function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  const db = {
    prepare(sql) {
      const statement = sqlite.prepare(sql); let args = [];
      return { bind(...values) { args = values; return this; }, async first() { return statement.get(...args) ?? null; }, async all() { return { results: statement.all(...args) }; }, async run() { return statement.run(...args); } };
    },
    async batch(statements) { sqlite.exec('BEGIN'); try { const results = []; for (const s of statements) results.push(await s.run()); sqlite.exec('COMMIT'); return results; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } }
  };
  const env = { DB: db, SESSION_SECRET: 'test-secret', ADMIN_PASSWORD: 'test-password' };
  sqlite.prepare('INSERT INTO sessions(token_hash,expires_at) VALUES(?,?)').run(createHash('sha256').update('test-token:test-secret').digest('hex'), '2099-01-01');
  const put = (kind,id,data) => sqlite.prepare('INSERT OR REPLACE INTO records(kind,id,data) VALUES(?,?,?)').run(kind,id,JSON.stringify(data));
  const records = kind => sqlite.prepare('SELECT id,data FROM records WHERE kind=?').all(kind).map(r => ({id:r.id,...JSON.parse(r.data)}));
  const balance = id => sqlite.prepare('SELECT quantity FROM stock_balances WHERE id=?').get(id)?.quantity;
  async function call(payload, headers = { authorization:'Bearer test-token' }) {
    const response = await worker.fetch(new Request('http://localhost/api/mutate',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(payload)}),env);
    return {status:response.status,...await response.json()};
  }
  put('cash','cash',{status:'open',opened_at:new Date().toISOString()});
  put('stock_items','beer',{name:'Cerveja',unit:'un',cost_price:3});
  sqlite.prepare('INSERT INTO stock_balances(id,quantity) VALUES(?,?)').run('beer',0);
  put('menu','beer',{name:'Cerveja',price:8,category:'Bebidas'});
  put('recipes','beer',{components:[{stock_item_id:'beer',quantity:1}]});
  return {sqlite,env,put,records,balance,call};
}
export { worker };
