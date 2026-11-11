import { sql } from 'drizzle-orm';
import { closeDb, db } from '../src/db/client';

/**
 * Métricas medidas a partir dos eventos persistidos (não estimativas):
 * tempo até o primeiro texto, duração total e custo por run, agrupados por perfil de execução.
 */
async function main() {
  const rows = await db().execute<{
    profile: string;
    runs: number;
    ttft_p50_ms: number | null;
    ttft_max_ms: number | null;
    duration_p50_ms: number | null;
    duration_max_ms: number | null;
    cost_avg_micro: number | null;
    cost_max_micro: number | null;
  }>(sql`
    with per_run as (
      select r.id,
        r.config_snapshot->>'model' as model,
        (select count(*) from run_steps s where s.run_id = r.id and s.kind = 'tool_call') as tools,
        exists (select 1 from run_events e where e.run_id = r.id and e.type = 'web_search') as searched,
        exists (select 1 from run_steps s where s.run_id = r.id and s.kind = 'compaction' and s.status = 'completed') as compacted,
        extract(epoch from ((select min(e.created_at) from run_events e where e.run_id = r.id and e.type = 'text_delta') - r.created_at)) * 1000 as ttft_ms,
        extract(epoch from (r.finished_at - r.created_at)) * 1000 as duration_ms,
        (select coalesce(sum(l.cost_micro), 0) from usage_ledger l join step_attempts a on a.id = l.attempt_id join run_steps s on s.id = a.step_id where s.run_id = r.id) as cost_micro
      from runs r
      where r.status = 'completed'
    )
    select
      model || ' · ' || case when compacted then 'com compactação' when searched then 'com busca web' when tools > 0 then 'com tools' else 'só texto' end as profile,
      count(*)::int as runs,
      round(percentile_cont(0.5) within group (order by ttft_ms))::int as ttft_p50_ms,
      round(max(ttft_ms))::int as ttft_max_ms,
      round(percentile_cont(0.5) within group (order by duration_ms))::int as duration_p50_ms,
      round(max(duration_ms))::int as duration_max_ms,
      round(avg(cost_micro))::int as cost_avg_micro,
      max(cost_micro)::int as cost_max_micro
    from per_run
    group by 1
    order by 1`);
  console.table(rows.rows);
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
