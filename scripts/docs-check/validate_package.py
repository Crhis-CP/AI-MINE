"""文档自检：`make verify` 的 docs 阶段。起点是交接包 v2.1 的 tools/validate_package.py，按
07-bootstrap/01-new-repo-bootstrap.md 3.1 改成在仓库里运行：只用标准库，不联网，不安装依赖，不写任何文件。

用法：python3 scripts/docs-check/validate_package.py            # 打印结果
      python3 scripts/docs-check/validate_package.py --strict   # 有任何错误则退出码 1（verify 用）
      python3 scripts/docs-check/validate_package.py --root <交接包目录>   # 检查交接包原件

检查项：
  1. Markdown：代码围栏成对、相对链接可达（docs/ 之外的仓库 Markdown 也查：根目录说明、tasks/、changes/、脚本说明）
  2. 编号：本包编号（F-/PG-/OP-/OUT-/DR-/BR-/AI-/ENT-/INV-/PIT-/AC-/Q-/DEC-/T-/ADR-）被引用但没有定义的清单
  3. 契约：03-data/contracts/openapi.json 与 domain-events.schema.json 可解析、$ref 不悬空、operationId 唯一
  4. 验收：05-quality/06-acceptance-scenarios.md 的 T 编号唯一；07-traceability.json 引用的 T/页面存在
  5. 上游来源：归档在交接包原件里时，tar.gz 成员哈希与 aihot-source-manifest.json 一致（流式校验）；
     在仓库里时（归档不入库），upstream/aihot.lock.json 与清单逐文件一致
  6. 数据：data/source-targets-320.json 与 .csv 记录数一致；原表 321 条；法域字典 36 个对象
  7. 追踪表：05-quality/07-traceability.json 自带检查项（无落点功能、未定义编号等）必须为空
  8. 敏感信息：扫描疑似 IPv4、邮箱、令牌与本机用户目录路径（作为警告列出）
相对交接包原件的改动：默认根目录是仓库的 docs/；不再写 evidence/package-validation.json；第 1 项扩到仓库
Markdown；第 5 项增加对 upstream/aihot.lock.json 的核对；函数名、提示文字与计数键不带上游名称（交接包原件
的 evidence 里同一组计数键带上游名称前缀）。
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import re
import sys
import tarfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
ROOT = Path(sys.argv[sys.argv.index("--root") + 1]).resolve() if "--root" in sys.argv else REPO / "docs"
IN_REPO = ROOT == REPO / "docs"
# 仓库里 docs/ 之外要查链接的 Markdown（相对仓库根目录）
REPO_MARKDOWN = ("*.md", "tasks/*.md", "changes/*.md", "scripts/**/*.md", ".github/*.md")
errors: list[str] = []
warnings: list[str] = []
counts: dict[str, int] = {}

SKIP_DIRS = ("research/aihot/", "_changes/", "tools/", "acceptance/2026-10-02-M0-baseline/")
ID_PREFIXES = r"(?:F-[A-Z]{2,4}-\d{2}|PG-\d{2}|OP-\d{2}|OUT-\d{2}|DR-\d{2,3}|BR-[A-Z]{2,4}-\d{2}|AI-\d{2}|ENT-\d{2}|INV-\d{2}|PIT-\d{3}|AC-[A-Z0-9]{2,4}-\d{2}|Q-\d{2}|DEC-\d{2}|T-\d{3}|ADR-\d{4})"
# 外来编号（旧仓库 ADR、法规分支的 T/R/D/K、整改需求 R）带前缀，不参与本包定义检查
ID_RE = re.compile(rf"(?<![A-Za-z0-9_\-\u65e7]){ID_PREFIXES}(?![A-Za-z0-9])")
EXTERNAL_RE = re.compile(r"(?:旧ADR-\d{4}|POL-[TRDK]\d{2}|REM-R\d{2})")
SENSITIVE = [
    (re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b"), "疑似 IPv4 地址"),
    (re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"), "疑似邮箱地址"),
    (re.compile(r"\b(?:sk-[A-Za-z0-9]{16,}|AKID[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|xox[abp]-[A-Za-z0-9-]{10,})"), "疑似密钥/令牌"),
    (re.compile(r"/Users/[A-Za-z0-9_.-]+/|/home/[A-Za-z0-9_.-]+/"), "本机用户目录路径"),
]


def check(ok: bool, msg: str, warn: bool = False) -> None:
    if not ok:
        (warnings if warn else errors).append(msg)


def md_files() -> list[Path]:
    out = []
    for p in sorted(ROOT.rglob("*.md")):
        rel = str(p.relative_to(ROOT))
        if rel.startswith(SKIP_DIRS) or rel.endswith("-全文.md"):
            continue
        out.append(p)
    return out


def check_repo_markdown() -> None:
    """docs/ 之外的仓库 Markdown：只查围栏与相对链接（编号定义只看 docs/）。"""
    if not IN_REPO:
        return
    seen: set[Path] = set()
    for pattern in REPO_MARKDOWN:
        for p in sorted(REPO.glob(pattern)):
            if p in seen or "node_modules" in p.parts:
                continue
            seen.add(p)
            rel = str(p.relative_to(REPO))
            text = p.read_text(encoding="utf-8")
            check(len(re.findall(r"^```", text, re.M)) % 2 == 0, f"代码围栏不成对：{rel}")
            for raw in re.findall(r"\]\(([^)]+)\)", text):
                target = raw.split("#")[0].strip().strip("<>")
                if not target or "://" in target or target.startswith(("mailto:", "/")):
                    continue
                check((p.parent / target).exists(), f"链接不可达：{rel} → {target}")
    counts["repo_markdown_files"] = len(seen)


def check_markdown() -> None:
    files = md_files()
    counts["markdown_files"] = len(files)
    defined: set[str] = set()
    referenced: dict[str, set[str]] = {}
    for p in files:
        rel = str(p.relative_to(ROOT))
        text = p.read_text(encoding="utf-8")
        check(len(re.findall(r"^```", text, re.M)) % 2 == 0, f"代码围栏不成对：{rel}")
        for raw in re.findall(r"\]\(([^)]+)\)", text):
            target = raw.split("#")[0].strip().strip("<>")
            if not target or "://" in target or target.startswith(("mailto:", "/")):
                continue
            check((p.parent / target).exists(), f"包内链接不可达：{rel} → {target}")
        for rx, label in SENSITIVE:
            for m in rx.finditer(text):
                frag = m.group(0)
                if label.startswith("疑似 IPv4") and (frag.startswith(("127.", "0.0.", "10.", "192.168.", "172.")) or frag.count(".") != 3):
                    continue
                if label.startswith("疑似邮箱") and frag.endswith(("example.com", "aiminingpolicy.com", "anthropic.com")):
                    continue
                warnings.append(f"{label}：{rel} … {frag[:40]}")
        for line in text.splitlines():
            s = line.strip()
            heads = []
            if s.startswith("|"):
                cells = [c.strip().strip("*` ") for c in s.strip("|").split("|")]
                if cells:
                    heads.append(cells[0])
            if s.startswith("#") or s.startswith("**") or s.startswith("- **"):
                heads.append(s)
            for h in heads:
                m = ID_RE.match(h.lstrip("#* -").strip())
                if m:
                    defined.add(m.group(0))
            for m in ID_RE.finditer(line):
                referenced.setdefault(m.group(0), set()).add(rel)
    counts["ids_defined"] = len(defined)
    counts["ids_referenced"] = len(referenced)
    missing = sorted(i for i in referenced if i not in defined)
    counts["ids_referenced_without_definition"] = len(missing)
    for i in missing:
        warnings.append(f"编号被引用但未见定义：{i}（{'、'.join(sorted(referenced[i])[:3])}）")


def resolve_pointer(doc: dict, pointer: str):
    x = doc
    for k in pointer[2:].split("/"):
        x = x[k.replace("~1", "/").replace("~0", "~")]
    return x


def walk_refs(doc: dict, node, rel: str) -> None:
    if isinstance(node, dict):
        if "$ref" in node and isinstance(node["$ref"], str) and node["$ref"].startswith("#/"):
            try:
                resolve_pointer(doc, node["$ref"])
            except Exception:
                errors.append(f"$ref 悬空：{rel} {node['$ref']}")
        for v in node.values():
            walk_refs(doc, v, rel)
    elif isinstance(node, list):
        for v in node:
            walk_refs(doc, v, rel)


def check_contracts() -> None:
    cdir = ROOT / "03-data" / "contracts"
    api_path = cdir / "openapi.json"
    if not api_path.exists():
        warnings.append("缺少 03-data/contracts/openapi.json")
        return
    api = json.loads(api_path.read_text(encoding="utf-8"))
    walk_refs(api, api, "openapi.json")
    ops = []
    for path, methods in api.get("paths", {}).items():
        for method, op in methods.items():
            if isinstance(op, dict) and "operationId" in op:
                ops.append(op["operationId"])
    check(len(ops) == len(set(ops)), "openapi.json 存在重复 operationId")
    counts["http_operations"] = len(ops)
    counts["dto_schemas"] = len(api.get("components", {}).get("schemas", {}))
    ev_path = cdir / "domain-events.schema.json"
    if ev_path.exists():
        ev = json.loads(ev_path.read_text(encoding="utf-8"))
        walk_refs(ev, ev, "domain-events.schema.json")
    for name in ("examples.json", "domain-event.example.json"):
        p = cdir / name
        if p.exists():
            json.loads(p.read_text(encoding="utf-8"))


def check_acceptance() -> None:
    qa = ROOT / "05-quality" / "06-acceptance-scenarios.md"
    if not qa.exists():
        warnings.append("缺少 05-quality/06-acceptance-scenarios.md")
        return
    text = qa.read_text(encoding="utf-8")
    ids = re.findall(r"^\| (T-\d{3}) \|", text, re.M)
    counts["acceptance_scenarios"] = len(ids)
    check(len(ids) == len(set(ids)), "验收场景 T 编号重复")
    tr = ROOT / "05-quality" / "07-traceability.json"
    if tr.exists():
        rows = json.loads(tr.read_text(encoding="utf-8")).get("requirements", [])
        counts["traceability_rows"] = len(rows)
        known = set(ids)
        for row in rows:
            for t in row.get("acceptance_ids", []):
                check(t in known, f"追踪表引用了不存在的场景 {t}（{row.get('id')}）", warn=True)


def check_upstream_lock(manifest: Path) -> None:
    """仓库里没有归档：upstream/aihot.lock.json 必须与清单逐文件一致（路径、字节数、SHA-256）。"""
    lock_path = REPO / "upstream/aihot.lock.json"
    if not lock_path.exists():
        errors.append("缺少 upstream/aihot.lock.json")
        return
    expected = {e["path"]: e for e in json.loads(manifest.read_text(encoding="utf-8"))["files"]}
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    got = {e["path"]: e for e in lock.get("files", [])}
    check(set(got) == set(expected), f"upstream/aihot.lock.json 的文件集合与清单不一致（{len(got)} / {len(expected)}）")
    for path, e in expected.items():
        g = got.get(path)
        if g is not None:
            check(g.get("sha256") == e["sha256"] and g.get("bytes") == e["bytes"], f"upstream/aihot.lock.json 与清单不符：{path}")
    man = json.loads(manifest.read_text(encoding="utf-8"))
    check(lock.get("commit") == man.get("commit"), "upstream/aihot.lock.json 的 commit 与清单不一致")
    check(lock.get("archive_sha256") == man.get("archive_sha256"), "upstream/aihot.lock.json 的归档哈希与清单不一致")
    counts["upstream_lock_files_checked"] = len(got)


def check_upstream_archive() -> None:
    adir = ROOT / "research/aihot"
    tars = list(adir.glob("AIHOT-*.tar.gz"))
    manifest = adir / "aihot-source-manifest.json"
    if not manifest.exists():
        warnings.append("research/aihot 缺少清单")
        return
    if IN_REPO:
        check_upstream_lock(manifest)
    if not tars:
        if not IN_REPO:
            warnings.append("research/aihot 缺少归档")
        return
    expected = {e["path"]: e["sha256"] for e in json.loads(manifest.read_text(encoding="utf-8"))["files"]}
    seen = 0
    with tarfile.open(tars[0], "r:gz") as tf:
        for m in tf:
            if not m.isfile():
                continue
            name = m.name.split("/", 1)[1] if "/" in m.name else m.name
            if name not in expected:
                continue
            f = tf.extractfile(m)
            h = hashlib.sha256(f.read()).hexdigest() if f else ""
            check(h == expected[name], f"上游归档成员哈希不符：{name}")
            seen += 1
    counts["upstream_files_hash_verified"] = seen
    check(seen == len(expected), f"上游归档成员数 {seen} 与清单 {len(expected)} 不一致")
    counts["upstream_archive_sha256_prefix"] = int(hashlib.sha256(tars[0].read_bytes()).hexdigest()[:8], 16)


def check_data() -> None:
    j = ROOT / "data" / "source-targets-320.json"
    c = ROOT / "data" / "source-targets-320.csv"
    if j.exists() and c.exists():
        data = json.loads(j.read_text(encoding="utf-8"))
        rows = data if isinstance(data, list) else data.get("targets") or data.get("items") or []
        with c.open(encoding="utf-8", newline="") as fh:
            n_csv = sum(1 for _ in csv.DictReader(fh))
        counts["source_targets_json"] = len(rows)
        counts["source_targets_csv"] = n_csv
        check(len(rows) == n_csv, f"信源目标 json({len(rows)}) 与 csv({n_csv}) 记录数不一致", warn=True)
    rec = ROOT / "data" / "source-records-321.csv"
    if rec.exists():
        with rec.open(encoding="utf-8", newline="") as fh:
            n_rec = sum(1 for _ in csv.DictReader(fh))
        counts["source_records_csv"] = n_rec
        check(n_rec == 321, f"原表记录数应为 321，实际 {n_rec}", warn=True)
    for name in ("jurisdictions-36.json", "jurisdiction-scope.json", "countries-18.json"):
        p = ROOT / "data" / name
        if p.exists():
            json.loads(p.read_text(encoding="utf-8"))
    jp = ROOT / "data" / "jurisdictions-36.json"
    if jp.exists():
        items = json.loads(jp.read_text(encoding="utf-8")).get("jurisdictions", [])
        top = [x for x in items if x.get("kind") in ("country", "organization")]
        counts["jurisdiction_objects"] = len(top)
        counts["jurisdiction_subdivisions"] = len(items) - len(top)
        check(len(top) == 36, f"法域字典应有 36 个对象（33 国 + 3 组织），实际 {len(top)}")


def check_traceability() -> None:
    """追踪表自带的检查项：下列清单必须为空（由追踪表生成时写入 checks）。"""
    tr = ROOT / "05-quality" / "07-traceability.json"
    if not tr.exists():
        return
    checks = json.loads(tr.read_text(encoding="utf-8")).get("checks", {})
    for key in (
        "F_without_T_or_pending",
        "T_without_F_INV_or_system",
        "INV_without_T",
        "INV_cover_undefined_T",
        "undefined_T_referenced",
        "PIT_without_T_or_INV",
        "H_without_PIT",
        "main_active_without_card",
        "main_active_without_landing",
        "AC_refs_unknown",
        "undefined_ids_in_json",
    ):
        value = checks.get(key)
        if value:
            errors.append(f"追踪表检查项 {key} 不为空：{str(value)[:120]}")
    counts["traceability_pending_cases"] = len(checks.get("pending_cases", {}) or {})


def main() -> None:
    check_markdown()
    check_repo_markdown()
    check_contracts()
    check_acceptance()
    check_upstream_archive()
    check_data()
    check_traceability()
    result = {
        "status": "PASS" if not errors else "FAIL",
        "scope": "只检查文档、契约与来源登记的自洽性；不代表产品已实现或验收",
        "counts": counts,
        "errors": errors,
        "warnings": warnings,
    }
    print(json.dumps({k: v for k, v in result.items() if k != "warnings"}, ensure_ascii=False, indent=2))
    print(f"warnings: {len(warnings)}")
    for w in warnings:
        print(f"  warning: {w}")
    if "--strict" in sys.argv and errors:
        sys.exit(1)


if __name__ == "__main__":
    main()
