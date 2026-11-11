import concurrent.futures as cf
import argparse
import re
import hashlib
import itertools
import json
import os
import random
import shutil
import subprocess as sp
import time
from pathlib import Path

model = "claude-haiku-4-5-20251001"
fields = (
    "input_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    "output_tokens",
)
items = {
    "shared": [
        (
            "clamp",
            "clamp(n,lo,hi): clamp to inclusive range; swap reversed bounds",
            [([12, 0, 10], 10), ([5, 10, 0], 5), ([-3, 0, 10], 0)],
        ),
        (
            "wrap",
            "wrap(n,lo,hi): wrap integer to inclusive range; swap reversed bounds",
            [([11, 0, 10], 0), ([-1, 0, 10], 10), ([23, 10, 0], 1)],
        ),
        (
            "steps",
            "steps(n,lo,hi): count distance from n to nearest point in inclusive range; swap reversed bounds",
            [([12, 10, 0], 2), ([5, 0, 10], 0), ([-3, 0, 10], 3)],
        ),
        (
            "width",
            "width(lo,hi): count integers in inclusive range; swap reversed bounds",
            [([2, 5], 4), ([5, 2], 4), ([3, 3], 1)],
        ),
    ],
    "independent": [
        (
            "slug",
            "slug(s): lowercase ASCII text, replace runs of non-alphanumerics with hyphens, trim hyphens",
            [([" Hello, World! "], "hello-world"), (["---"], ""), (["A_2"], "a-2")],
        ),
        (
            "unique",
            "unique(a): return unique primitive values in first-seen order",
            [([[1, 2, 1]], [1, 2]), ([[]], []), ([["a", "b", "a"]], ["a", "b"])],
        ),
        (
            "median",
            "median(a): numeric median without modifying input; empty array returns null",
            [([[2, 10, 1]], 2), ([[4, 2]], 3), ([[]], None)],
        ),
        (
            "pad",
            "pad(s,n): left-pad string with zeros to length n; preserve longer strings",
            [(["7", 3], "007"), (["abcd", 2], "abcd"), (["", 2], "00")],
        ),
    ],
}
env = {
    k: v
    for k, v in os.environ.items()
    if k
    not in (
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_MODEL",
        "CLAUDE_CODE_OAUTH_TOKEN",
    )
}
env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1"


def cmd(*a, cwd, **kw):
    return sp.run(a, cwd=cwd, check=True, text=True, capture_output=True, **kw).stdout


def git(cwd, *a):
    return cmd("git", *a, cwd=cwd)


def setup(name, entries):
    repo = root / (name + "-base")
    repo.mkdir()
    git(repo, "init", "-q")
    (repo / "SPEC.md").write_text(
        "\n".join((f"{n}.mjs: {desc}" for n, desc, _ in entries)) + "\n"
    )
    test = [
        "import assert from 'node:assert/strict';",
        "import {test} from 'node:test';",
    ]
    for n, _, cases in entries:
        (repo / (n + ".mjs")).write_text(
            f"export function {n}(...args) {{ return undefined; }}\n"
        )
        test.append(f"import {{ {n} }} from './{n}.mjs';")
        for i, (args, result) in enumerate(cases):
            test.append(
                f"test('{n}-{i}',()=>{{const a={json.dumps(args)};const before=structuredClone(a); assert.deepEqual({n}(...a),{json.dumps(result)});assert.deepEqual(a,before);}});"
            )
    (repo / "verify.mjs").write_text("\n".join(test) + "\n")
    git(repo, "add", ".")
    cmd(
        "git",
        "-c",
        "user.name=HIVEMIND Experiment",
        "-c",
        "user.email=experiment@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-qm",
        "Freeze benchmark input",
        cwd=repo,
        env={
            **os.environ,
            "GIT_AUTHOR_DATE": "2026-11-11T00:00:00Z",
            "GIT_COMMITTER_DATE": "2026-11-11T00:00:00Z",
        },
    )
    return (repo, git(repo, "rev-parse", "HEAD").strip())


def session(wd, selected, logfile, deadline=None):
    before = {p.name: p.read_bytes() for p in wd.iterdir() if p.is_file()}
    started = time.time()
    prompt = (
        "Implement the assigned functions only. Read SPEC.md and each assigned .mjs file. Edit only assigned modules, without adding files or changing exports. Do not edit tests or run shell commands. Implement exact stated behavior. Assigned: "
        + ", ".join(selected)
        + "."
    )
    args = [
        "claude",
        "-p",
        "--restricted",
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
        "--tools",
        "Read,Edit",
        "--allowedTools",
        "Read,Edit",
        "--model",
        model,
        "--effort",
        "low",
        "--output-format",
        "stream-json",
        "--verbose",
        "--max-turns",
        "16",
        "--no-session-persistence",
        "--",
        prompt,
    ]
    t = time.monotonic()
    with logfile.open("w") as out, logfile.with_suffix(".stderr").open("w") as err:
        proc = sp.Popen(
            args, cwd=wd, env=env, stdout=out, stderr=err, start_new_session=True
        )
        try:
            rc = proc.wait(
                timeout=max(1, deadline - time.monotonic()) if deadline else 100
            )
        except sp.TimeoutExpired:
            os.killpg(proc.pid, 15)
            rc = proc.wait(timeout=10)
    events = []
    for line in logfile.read_text().splitlines():
        try:
            events.append(json.loads(line))
        except ValueError:
            pass
    final = next((e for e in reversed(events) if e.get("type") == "result"), {})
    usage = final.get("usage") or {}
    models = sorted(
        {
            e["message"]["model"]
            for e in events
            if e.get("type") == "assistant"
            and isinstance(e.get("message", {}).get("model"), str)
            and (not e["message"]["model"].startswith("<"))
        }
    )
    diff = git(wd, "diff", "--binary", "HEAD")
    after = {p.name: p.read_bytes() for p in wd.iterdir() if p.is_file()}
    changed = sorted(
        (k for k in before.keys() | after.keys() if before.get(k) != after.get(k))
    )
    allowed = {n + ".mjs" for n in selected}
    scope = set(changed) <= allowed and (
        not git(wd, "ls-files", "--others", "--exclude-standard").strip()
    )
    return {
        "started_at": started,
        "ended_at": time.time(),
        "seconds": round(time.monotonic() - t, 3),
        "rc": rc,
        "subtype": final.get("subtype"),
        "ok": rc == 0
        and final.get("is_error") is False
        and (models == [model])
        and scope,
        "models": models,
        "session_id": final.get("session_id"),
        "usage": {k: usage.get(k) for k in fields},
        "cache_creation": usage.get("cache_creation"),
        "cli_cost_usd": final.get("total_cost_usd"),
        "num_turns": final.get("num_turns"),
        "files": changed,
        "diff": diff,
    }


def run(repo, name, condition, names, block, order):
    tag = f"{name}-{block}-{condition}"
    folder = root / tag
    folder.mkdir()
    t = time.monotonic()
    deadline = t + 180

    def clone(label):
        wd = folder / label
        git(folder, "clone", "-q", "--no-hardlinks", str(repo), str(wd))
        return wd

    wd = clone("result")
    groups = {"A": [names], "B": [names[:2], names[2:]], "C": [[n] for n in names]}[
        condition
    ]
    if condition == "C":
        isolated = [clone(str(i)) for i in range(len(groups))]
        with cf.ThreadPoolExecutor(2) as pool:
            futures = [
                pool.submit(session, isolated[i], g, folder / f"{i}.jsonl", deadline)
                for i, g in enumerate(groups)
            ]
            ses = [f.result() for f in futures]
        integration_start = time.monotonic()
        for g, rec, w in zip(groups, ses, isolated):
            if rec["ok"]:
                shutil.copyfile(w / (g[0] + ".mjs"), wd / (g[0] + ".mjs"))
    else:
        ses = [
            session(wd, g, folder / f"{i}.jsonl", deadline)
            for i, g in enumerate(groups)
        ]
        integration_start = time.monotonic()
    verify_start = time.monotonic()
    p = sp.run(
        ["node", "--test", "verify.mjs"],
        cwd=wd,
        text=True,
        capture_output=True,
        timeout=20,
    )
    diff = git(wd, "diff", "--binary", "HEAD")
    tests = {
        k: int(
            next(
                (
                    line.split()[-1]
                    for line in p.stdout.splitlines()
                    if re.match("^[#ℹ] " + k + " \\d+$", line)
                ),
                0,
            )
        )
        for k in ("tests", "pass", "fail")
    }
    result = {
        "task": name,
        "condition": condition,
        "block": block,
        "order": order,
        "base": git(repo, "rev-parse", "HEAD").strip(),
        "seconds": round(time.monotonic() - t, 3),
        "tests": tests,
        "verification_seconds": round(time.monotonic() - verify_start, 3),
        "integration_seconds": round(verify_start - integration_start, 3),
        "test_exit": p.returncode,
        "success": p.returncode == 0
        and tests["pass"] == 12
        and all((x["ok"] for x in ses)),
        "sha256": hashlib.sha256(diff.encode()).hexdigest(),
        "sessions": [{k: v for k, v in x.items() if k != "diff"} for x in ses],
    }
    (folder / "diff.patch").write_text(diff)
    (folder / "tests.txt").write_text(p.stdout + p.stderr)
    with (root / "runs.jsonl").open("a") as f:
        f.write(json.dumps(result) + "\n")
    print(
        tag,
        result["success"],
        result["seconds"],
        [x["subtype"] for x in ses],
        flush=True,
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Run the Claude Code context-continuity experiment."
    )
    parser.add_argument("mode", choices=["probe", "full"])
    parser.add_argument(
        "output_dir", type=Path, help="New private directory for fixtures and raw logs"
    )
    args = parser.parse_args()
    root = args.output_dir.resolve()
    root.mkdir(mode=0o700, parents=True)
    os.umask(0o077)
    if args.mode == "probe":
        repo, _ = setup("probe", items["shared"])
        rec = session(repo, ["clamp"], root / "probe.jsonl")
        print(json.dumps({k: v for k, v in rec.items() if k != "diff"}))
    else:
        for name, entries in items.items():
            repo, base = setup(name, entries)
            orders = list(itertools.permutations("ABC"))
            random.Random(20261111).shuffle(orders)
            print(name, base, orders, flush=True)
            for block, order in enumerate(orders, 1):
                for pos, cond in enumerate(order, 1):
                    run(repo, name, cond, [x[0] for x in entries], block, pos)
