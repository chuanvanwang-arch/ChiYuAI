// test/monitor/attribution-column.test.js
import { query } from '../../src/db.js';
import { describe, it, expect } from 'vitest';

describe('decision.attribution column', () => {
  it('crm.decision has attribution JSONB column', async () => {
    const r = await query(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema='crm' AND table_name='decision' AND column_name='attribution'`
    );
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].data_type).toBe('jsonb');
  });
});
