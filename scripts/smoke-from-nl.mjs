// 验证 /api/page/from-nl 重启后是否返回 notes（绕过 curl 引号地狱）
import http from 'node:http';
const NL = process.argv[2] || '涂料新品配方需要特种润湿分散剂，先要 600g 样品';
const data = JSON.stringify({ nl: NL });
const req = http.request(
  {
    host: 'localhost',
    port: 3000,
    path: '/api/page/from-nl',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
  },
  (res) => {
    let b = '';
    res.on('data', (c) => (b += c));
    res.on('end', () => {
      console.log('HTTP', res.statusCode);
      try {
        const j = JSON.parse(b);
        console.log('has notes:', Array.isArray(j.notes) ? `YES (${j.notes.length} 条)` : 'NO');
        console.log(JSON.stringify(j, null, 2).slice(0, 600));
      } catch {
        console.log(b.slice(0, 400));
      }
    });
  }
);
req.on('error', (e) => {
  console.error('REQ ERR', e.message);
  process.exit(1);
});
req.write(data);
req.end();
