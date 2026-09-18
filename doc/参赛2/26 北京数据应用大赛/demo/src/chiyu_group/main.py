"""CLI：流式回放 / 评测 / 导出预测。对齐计划 M5/M9 契约。

用法:
    python -m chiyu_group.main --evaluate [--dataset sample] [--threshold 0.5] [--out output/]
    python -m chiyu_group.main --replay  [--dataset sample] [--threshold 0.5]
    python -m chiyu_group.main --export  [--dataset sample] [--threshold 0.5] [--out output/]
"""
import argparse
import json
import time
from pathlib import Path

from chiyu_group.ingest.loader import load_sample
from chiyu_group.ingest.mapper import raw_to_ticket
from chiyu_group.features.text_sem import text_features
from chiyu_group.features.geo_addr import admin_of_office, extract_district
from chiyu_group.features.entity_graph import extract_entities, EntityGraph
from chiyu_group.features.infer import InferBackend, cosine
from chiyu_group.memory.lifecycle import ClusterLifecycle
from chiyu_group.decision.adjudicate import adjudicate
from chiyu_group.decision.redline import check_redline
from chiyu_group.decision.audit import AuditRecord, AuditStore
from chiyu_group.evaluate.replay import StreamReplay
from chiyu_group.evaluate.metrics import macro_f1, cross_day_accuracy, min_sensitivity
from chiyu_group.evaluate.report import build_report


def run_replay(dataset: str = "sample", threshold: float = 0.5, collect_truth: bool = True):
    """流式回放样例，返回 (clusters, audits, latency_ms列表, truth)。"""
    tickets = load_sample()
    backend = InferBackend(backend="none")
    graph = EntityGraph()
    life = ClusterLifecycle()
    audits = AuditStore()
    clusters = {}

    latencies = []

    def on_tick(t):
        t0 = time.perf_counter()
        tf = text_features(text=t.text, backend=backend)
        admin = admin_of_office(t.office_name)
        d = extract_district(t.address)
        ents = extract_entities(t.text)
        graph.add_ticket(t.order_id, ents)
        best, best_score = None, 0.0
        for cid, note in clusters.items():
            s = cosine(tf["vec"], note.get("center_vec"))
            if s > best_score:
                best_score, best = s, cid
        cands = [(best, best_score)] if best is not None else []
        redline, reason = False, ""
        if best is not None:
            redline, reason = check_redline(admin, clusters[best].get("admin", ""),
                                            t.question_name, clusters[best].get("question", ""))
        out = adjudicate(cands, bool(redline), threshold=threshold,
                         archived_candidates=[], now=t.push_time)
        if out["action"] == "join" and best:
            note = clusters[best]
            note["size"] = note.get("size", 0) + 1
            note["center_vec"] = (note["center_vec"] + tf["vec"]) / 2
            note["last_seen"] = t.push_time.isoformat()
            life.touch(best, t.push_time)
        elif out["action"] == "create":
            cid = f"C{len(clusters)+1}"
            clusters[cid] = {"center_vec": tf["vec"], "size": 1, "status": "active",
                             "entities": list(ents), "admin": admin,
                             "question": t.question_name, "last_seen": t.push_time.isoformat()}
            life.touch(cid, t.push_time)
        audits.add(AuditRecord(order_id=t.order_id, action=out["action"],
                               cluster_id=out.get("cluster_id"), scores={},
                               fused=best_score if best else 0.0, confidence=0.5,
                               redline_hit=bool(redline), redline_reason=reason,
                               strategy_version="v1", ts=t.push_time))
        latencies.append((time.perf_counter() - t0) * 1000)

    StreamReplay(on_tick=on_tick).feed(tickets)

    truth = {}
    if collect_truth:
        for t in tickets:
            if getattr(t, "gid", None):
                truth.setdefault(t.gid, set()).add(t.order_id)
    return clusters, audits, latencies, truth


def _latency_stats(ms: list[float]) -> dict:
    ordered = sorted(ms)
    n = len(ordered)
    p50 = ordered[int(n * 0.50)] if n else 0.0
    p95 = ordered[min(int(n * 0.95), n - 1)] if n else 0.0
    return {"count": n, "mean_ms": sum(ms) / n if n else 0.0,
            "p50_ms": p50, "p95_ms": p95}


def evaluate(dataset: str = "sample", threshold: float = 0.5, out: str = "output") -> dict:
    clusters, audits, latencies, truth = run_replay(dataset, threshold)
    stats = _latency_stats(latencies)

    # 从审计记录构造预测（action=join 的工单归属其簇）
    pred = {}
    for rec in audits._records.values():
        if rec.action == "join" and rec.cluster_id:
            pred.setdefault(rec.cluster_id, set()).add(rec.order_id)

    mf1, per_event = macro_f1(pred, truth)
    # 跨日合并：truth 中 gid 相同的工单若跨多个日期
    from collections import defaultdict
    day_groups = defaultdict(set)
    for t in __import__("chiyu_group.ingest.loader", fromlist=["load_sample"]).load_sample():
        if getattr(t, "gid", None):
            day_groups[t.gid].add(t.push_time.date().isoformat() if t.push_time else "")
    multi = {g: len(d) > 1 for g, d in day_groups.items()}
    merged = {g: (g in pred) for g in multi}
    cda = cross_day_accuracy(multi, merged)

    small = {g: s for g, s in truth.items() if 3 <= len(s) <= 5}
    found = {g for g in pred}
    ms = min_sensitivity(small, found)

    metrics = {"macro_f1": mf1, "per_event": per_event,
               "cross_day_acc": cda, "min_sensitivity": ms,
               "latency_ms_p50": round(stats["p50_ms"], 1),
               "latency_ms_p95": round(stats["p95_ms"], 1),
               "latency_mean_ms": round(stats["mean_ms"], 1),
               "clusters": len(clusters), "tickets": stats["count"]}
    report = build_report(metrics)
    outdir = Path(out)
    outdir.mkdir(parents=True, exist_ok=True)
    (outdir / "eval_report.json").write_text(
        json.dumps(metrics, ensure_ascii=False, indent=2), encoding="utf-8")
    (outdir / "eval_report.md").write_text(report["markdown"], encoding="utf-8")
    return metrics


def export(dataset: str = "sample", threshold: float = 0.5, out: str = "output"):
    clusters, audits, latencies, truth = run_replay(dataset, threshold)
    outdir = Path(out)
    outdir.mkdir(parents=True, exist_ok=True)
    lines = ["order_id,gid"]
    for rec in audits._records.values():
        lines.append(f"{rec.order_id},{rec.cluster_id or ''}")
    (outdir / "predictions.csv").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"exported {len(audits._records)} rows -> {outdir}/predictions.csv")


def main():
    p = argparse.ArgumentParser(description="chiyu-group 群诉智能发现 DEMO CLI")
    p.add_argument("--evaluate", action="store_true", help="运行评测并写 output/eval_report.*")
    p.add_argument("--replay", action="store_true", help="流式回放（打印簇统计）")
    p.add_argument("--export", action="store_true", help="导出 predictions.csv")
    p.add_argument("--dataset", default="sample")
    p.add_argument("--threshold", type=float, default=0.5)
    p.add_argument("--out", default="output")
    args = p.parse_args()

    if args.evaluate:
        m = evaluate(args.dataset, args.threshold, args.out)
        print(json.dumps({k: v for k, v in m.items() if k != "per_event"},
                         ensure_ascii=False, indent=2))
    elif args.replay:
        clusters, audits, latencies, _ = run_replay(args.dataset, args.threshold)
        st = _latency_stats(latencies)
        print(f"replay: clusters={len(clusters)} tickets={st['count']} "
              f"mean={st['mean_ms']:.1f}ms p50={st['p50_ms']:.1f}ms p95={st['p95_ms']:.1f}ms")
    elif args.export:
        export(args.dataset, args.threshold, args.out)
    else:
        p.print_help()


if __name__ == "__main__":
    main()
