const g = await import('/app/src/decision/ageGraph.js');
const e = await import('/app/src/ontology/embedding.js');

await g.ensureGraph();
console.log('AGE_AVAILABLE=', g.isAvailable());

for (const q of ['MATCH (n) RETURN {c: count(n)} AS v', 'MATCH (n) RETURN {id: n.decision_id} AS v LIMIT 3']) {
  try {
    const r = await g.runCypher(q);
    console.log('CYPHER_OK', q, '=>', JSON.stringify(r));
  } catch (err) {
    console.log('CYPHER_ERR', q, '=>', err.message);
  }
}

const A = await e.embedText('客户要求降价并延期付款');
const B = await e.embedText('客户希望降低价格并推迟付款');
const C = await e.embedText('今天中午食堂吃什么');
const cos = (x, y) => {
  let d = 0, n = 0, m = 0;
  for (let i = 0; i < x.length; i++) { d += x[i] * y[i]; n += x[i] * x[i]; m += y[i] * y[i]; }
  return d / Math.sqrt(n * m);
};
console.log('EMBED_PROVIDER=', A.provider, 'DIM=', A.dim);
console.log('SIM_NEAR=', cos(A.vector, B.vector).toFixed(4), 'SIM_FAR=', cos(A.vector, C.vector).toFixed(4));
process.exit(0);
