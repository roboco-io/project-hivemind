import argparse
import itertools
import json
import re
import statistics
from collections import defaultdict
from pathlib import Path

parser = argparse.ArgumentParser(
    description="Summarize a context continuity experiment from preserved test reports."
)
parser.add_argument("output_dir", type=Path)
root = parser.parse_args().output_dir.resolve()
rows = [json.loads(line) for line in (root / "runs.jsonl").read_text().splitlines()]
summary = defaultdict(list)
records = []
previous_session_end = None
for row in rows:
    tag = f"{row['task']}-{row['block']}-{row['condition']}"
    report = (root / tag / "tests.txt").read_text()
    counts = {
        key: int(m.group(1))
        if (m := re.search(rf"^[#ℹ] {key} (\d+)$", report, re.M))
        else None
        for key in ("tests", "pass", "fail")
    }
    sessions = row["sessions"]
    intervals = [(s["started_at"], s["ended_at"]) for s in sessions]
    overlap = sum(
        max(0, min(a[1], b[1]) - max(a[0], b[0]))
        for a, b in itertools.combinations(intervals, 2)
    )
    fields = (
        "input_tokens",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
        "output_tokens",
    )
    usage = {
        k: sum(s["usage"][k] for s in sessions)
        if all(isinstance(s["usage"][k], int) for s in sessions)
        else None
        for k in fields
    }
    rates = {"input_tokens": 1, "cache_read_input_tokens": 0.10, "output_tokens": 5}
    if all(v is not None for v in usage.values()) and all(
        isinstance(s["cache_creation"], dict) for s in sessions
    ):
        ttl5 = sum(
            s["cache_creation"].get("ephemeral_5m_input_tokens", 0) for s in sessions
        )
        ttl60 = sum(
            s["cache_creation"].get("ephemeral_1h_input_tokens", 0) for s in sessions
        )
        if ttl5 + ttl60 != usage["cache_creation_input_tokens"]:
            raise ValueError(f"Cache TTL total mismatch: {tag}")
        usd = (
            sum(usage[k] * rate for k, rate in rates.items()) + ttl5 * 1.25 + ttl60 * 2
        ) / 1e6
    else:
        ttl5 = ttl60 = usd = None
    cli_cost = (
        sum(s["cli_cost_usd"] for s in sessions)
        if all(isinstance(s["cli_cost_usd"], (int, float)) for s in sessions)
        else None
    )
    success = (
        row["test_exit"] == 0
        and counts == {"tests": 12, "pass": 12, "fail": 0}
        and all(s["ok"] for s in sessions)
    )
    entry = {k: v for k, v in row.items() if k not in ("sessions", "success", "tests")}
    session_start = min(start for start, _ in intervals)
    session_end = max(end for _, end in intervals)
    gap = (
        round(session_start - previous_session_end, 3)
        if previous_session_end is not None
        else None
    )
    previous_session_end = session_end
    entry.update(
        gap_from_previous_session_seconds=gap,
        tests=counts,
        success=success,
        usage=usage,
        cache_creation_5m=ttl5,
        cache_creation_1h=ttl60,
        estimated_api_usd=usd,
        cli_reported_usd=cli_cost,
        session_count=len(sessions),
        session_overlap_seconds=round(overlap, 3),
        sessions=[
            {
                **{
                    k: v
                    for k, v in s.items()
                    if k not in ("session_id", "started_at", "ended_at")
                },
                "start_offset_seconds": round(
                    s["started_at"] - min(a[0] for a in intervals), 3
                ),
                "end_offset_seconds": round(
                    s["ended_at"] - min(a[0] for a in intervals), 3
                ),
            }
            for s in sessions
        ],
    )
    records.append(entry)
    summary[row["task"], row["condition"]].append(entry)
print("runs", len(records), "sessions", sum(x["session_count"] for x in records))
for (task, condition), group in sorted(summary.items()):
    good = [x for x in group if x["success"]]

    def median(key):
        values = [x[key] for x in good]
        return (
            round(statistics.median(values), 6)
            if values and None not in values
            else None
        )

    medianusage = {
        k: statistics.median(x["usage"][k] for x in good)
        if good and all(x["usage"][k] is not None for x in good)
        else None
        for k in fields
    }
    print(
        task,
        condition,
        "success",
        len(good),
        len(group),
        "wall",
        median("seconds"),
        "wallrange",
        [min(x["seconds"] for x in good), max(x["seconds"] for x in good)]
        if good
        else [],
        "usd",
        median("estimated_api_usd"),
        "costrange",
        [
            min(x["estimated_api_usd"] for x in good),
            max(x["estimated_api_usd"] for x in good),
        ]
        if good and all(x["estimated_api_usd"] is not None for x in good)
        else [],
        "total_per_success",
        round(sum(x["estimated_api_usd"] for x in group) / len(good), 6)
        if good and all(x["estimated_api_usd"] is not None for x in group)
        else None,
        "overlap",
        median("session_overlap_seconds"),
        "usage",
        medianusage,
    )
for task in sorted({x["task"] for x in records}):
    for comparison in ("B", "C"):
        pairs = []
        for block in range(1, 7):
            a = next((x for x in summary[task, "A"] if x["block"] == block), None)
            b = next(
                (x for x in summary[task, comparison] if x["block"] == block), None
            )
            if a and b and a["success"] and b["success"]:
                pairs.append(
                    (
                        b["seconds"] - a["seconds"],
                        b["estimated_api_usd"] - a["estimated_api_usd"]
                        if None not in (a["estimated_api_usd"], b["estimated_api_usd"])
                        else None,
                    )
                )
        if pairs:
            cost_differences = [cost for _, cost in pairs if cost is not None]
            print(
                task,
                comparison + "-A",
                "paired",
                len(pairs),
                "wall_diff",
                round(statistics.median(x[0] for x in pairs), 3),
                "usd_diff",
                round(statistics.median(cost_differences), 6)
                if cost_differences
                else None,
            )
print(
    "failures",
    [
        (
            x["task"],
            x["block"],
            x["condition"],
            x["tests"],
            [
                (s["rc"], s["subtype"], s["models"])
                for s in x["sessions"]
                if not s["ok"]
            ],
        )
        for x in records
        if not x["success"]
    ],
)
if len(records) == 36:
    (root / "evidence.json").write_text(
        json.dumps(
            {
                "model": "claude-haiku-4-5-20251001",
                "cli": "2.1.321",
                "node": "24.14.0",
                "order_seed": 20261111,
                "runs": records,
            },
            indent=2,
        )
        + "\n"
    )
