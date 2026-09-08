// 一次性核验：对话决策建议配置落库内容（生产库）
import pg from 'pg';
const c = new pg.Client({ host: 'localhost', port: 5433, user: 'agent2b', password: 'agent2b', database: process.env.PGDATABASE || 'crm_native' });
await c.connect();
const r = await c.query("select key, value from crm.config_store where key in ('dialog-scenario-map','dialog-advisor-config')");
for (const row of r.rows) {
  if (row.key === 'dialog-scenario-map') {
    const map = row.value.map;
    console.log('场景数:', map.length, '|', map.map((e) => e.scenario_id).join(','));
    console.log('QUOTE_PRICING 关键词:', map.find((e) => e.scenario_id === 'QUOTE_PRICING').keywords.join(','));
  } else {
    console.log('阈值配置:', JSON.stringify(row.value));
  }
}
await c.end();
