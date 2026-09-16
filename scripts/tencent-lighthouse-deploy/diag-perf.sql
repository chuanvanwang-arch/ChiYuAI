-- 生产性能诊断（只读，无写操作）
\pset pager off
\echo '===== ① 库与表规模 TOP15 ====='
select relname,
       pg_size_pretty(pg_total_relation_size(c.oid)) as total_sz,
       pg_size_pretty(pg_relation_size(c.oid))       as heap_sz,
       pg_size_pretty(pg_indexes_size(c.oid))        as idx_sz,
       coalesce(s.n_live_tup,0)                      as rows
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
left join pg_stat_user_tables s on s.relid = c.oid
where n.nspname='crm' and c.relkind in ('r','m')
order by pg_total_relation_size(c.oid) desc
limit 15;

\echo ''
\echo '===== ② 全库大小 / 扩展 / 版本 ====='
select pg_size_pretty(pg_database_size('crm_native')) as db_size,
       current_setting('server_version') as pg_ver;
select extname from pg_extension order by 1;

\echo ''
\echo '===== ③ 顺序扫描最多的表（缺索引嫌疑）====='
select relname,
       seq_scan,
       coalesce(idx_scan,0) as idx_scan,
       coalesce(n_live_tup,0) as rows,
       pg_size_pretty(pg_total_relation_size(relid)) as sz
from pg_stat_user_tables
where schemaname='crm' and seq_scan > 0
order by seq_scan desc
limit 15;

\echo ''
\echo '===== ④ 无任何索引的表 ====='
select c.relname, coalesce(s.n_live_tup,0) as rows
from pg_class c
join pg_namespace n on n.oid=c.relnamespace
left join pg_index i on i.indrelid=c.oid
left join pg_stat_user_tables s on s.relid=c.oid
where n.nspname='crm' and c.relkind='r'
group by c.relname, s.n_live_tup
having count(i.indexrelid)=0
order by s.n_live_tup desc nulls last
limit 25;

\echo ''
\echo '===== ⑤ 行数 TOP12 ====='
select relname, n_live_tup as rows,
       coalesce(n_tup_ins,0) ins, coalesce(n_tup_upd,0) upd, coalesce(n_tup_del,0) delx
from pg_stat_user_tables
where schemaname='crm'
order by n_live_tup desc
limit 12;

\echo ''
\echo '===== ⑥ 死元组/需要 autovacuum 的表 ====='
select relname, n_live_tup, n_dead_tup,
       last_autovacuum, last_autoanalyze
from pg_stat_user_tables
where schemaname='crm' and n_dead_tup > 20
order by n_dead_tup desc
limit 15;

\echo ''
\echo '===== ⑦ 关键 PG 参数 ====='
select name, setting, unit
from pg_settings
where name in ('shared_buffers','work_mem','maintenance_work_mem','effective_cache_size',
               'max_connections','random_page_cost','effective_io_concurrency',
               'shared_preload_libraries','track_io_timing','max_worker_processes',
               'wal_buffers','checkpoint_completion_target','synchronous_commit',
               'jit','temp_buffers','min_parallel_table_scan_size')
order by name;

\echo ''
\echo '===== ⑧ 当前连接数与状态 ====='
select state, count(*) from pg_stat_activity where datname='crm_native' group by state;
select 'max_conn='||current_setting('max_connections') as x;

\echo ''
\echo '===== ⑨ 活动查询（是否有长事务/锁等待）====='
select pid, state, now()-query_start as dur, left(query, 90) as q
from pg_stat_activity
where datname='crm_native' and state <> 'idle'
order by query_start asc
limit 10;

\echo ''
\echo '===== ⑩ 缓存命中率 ====='
select 'buffer_cache_hit=' ||
       round(100.0*sum(blks_hit)/nullif(sum(blks_hit)+sum(blks_read),0), 2) || '%' as x
from pg_stat_database where datname='crm_native';
select relname, heap_blks_read, heap_blks_hit,
       round(100.0*heap_blks_hit/nullif(heap_blks_hit+heap_blks_read,0),1) as hit_pct
from pg_statio_user_tables
where schemaname='crm' and (heap_blks_read+heap_blks_hit) > 0
order by heap_blks_read desc limit 10;

\echo ''
\echo '===== ⑪ pg_stat_statements 是否可用 ====='
select count(*) as has_pgss from pg_extension where extname='pg_stat_statements';
