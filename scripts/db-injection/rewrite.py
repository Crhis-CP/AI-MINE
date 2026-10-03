#!/usr/bin/env python3
"""TASK-0004 PR3b: replay only the declared connection-injection changes on the exact base files.
Usage: python3 scripts/db-injection/rewrite.py [clean-base-directory]
All input hashes are checked before any write; SQL and business bodies are left unchanged.
"""
import hashlib
import json
import re
import sys
from pathlib import Path

source = Path(__file__).resolve().parents[2]
root = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else source
mapping = json.loads((source / 'scripts/db-injection/mapping.json').read_text())
texts = {}
for name, digest in mapping['inputs'].items():
    raw = (root / name).read_bytes()
    if hashlib.sha256(raw).hexdigest() != digest:
        raise SystemExit(f'base file changed (nothing written): {name}')
    texts[name] = raw.decode()
imports = re.compile(r'^import\b[\s\S]*?;$', re.M)
db_import = re.compile(r'^import\s*\{([^}]+)\}\s*from\s*(["\'])([^"\']+)["\'];', re.M)

def add_after_imports(text, code):
    end = list(imports.finditer(text))[-1].end()
    return text[:end] + '\n\n' + code + text[end:]

def add_initializer(text, role):
    target = next(m for m in db_import.finditer(text) if m[3] == '@amp/backend/db')
    names = target[1].strip() + ', initializeDb'
    text = text[:target.start(1)] + ' ' + names + ' ' + text[target.end(1):]
    return add_after_imports(text, f'await initializeDb("{role}");')

for name, entry in mapping['files'].items():
    text = texts[name]
    target = next(m for m in db_import.finditer(text) if 'sql' in [x.strip() for x in m[1].split(',')] and (m[3].endswith('/db.ts') or m[3] == '@amp/backend/db'))
    names = re.sub(r'\bsql\b', 'dbOf', target[1])
    text = text[:target.start(1)] + names + text[target.end(1):]
    texts[name] = add_after_imports(text, f'const sql = dbOf("{entry["module"]}");')

entrypoints = {
    'apps/api/src/main.ts': 'api', 'apps/worker/src/main.ts': 'worker',
    'scripts/migrate.ts': 'migrate', 'scripts/seed.ts': 'migrate',
    **{f'scripts/{name}.ts': 'worker' for name in ['collect', 'delete-sources', 'enqueue-analysis', 'eval-relations', 'eval-selection', 'regroup-events']},
}
for name, role in entrypoints.items():
    texts[name] = add_initializer(texts[name], role)
for name in ['tests/analyze-shutdown.test.ts', 'tests/translate-shutdown.test.ts']:
    needle = "    import { closeDb } from '@amp/backend/db';"
    assert texts[name].count(needle) == 1
    texts[name] = texts[name].replace(needle, "    import { closeDb, initializeDb } from '@amp/backend/db';\n    await initializeDb('test');")

name = 'tests/setup.ts'
texts[name] = texts[name].replace('import http from "node:http";', 'import http from "node:http";\nimport { initializeDb } from "@amp/backend/db";')
needle = 'for (const [name, model] of Object.entries(PRESET_MODELS)) process.env[name] ??= model;'
assert texts[name].count(needle) == 1
texts[name] = texts[name].replace(needle, needle + '\nawait initializeDb("test");')
name = 'scripts/baseline/capture.ts'
texts[name] = texts[name].replace('import path from "node:path";', 'import path from "node:path";\nimport { initializeDb } from "@amp/backend/db";')
needle = 'const { buildApp } = await import("../../apps/api/src/app.ts");'
texts[name] = texts[name].replace(needle, 'await initializeDb("test");\n' + needle)

name = 'packages/backend/src/db.ts'
text = texts[name].replace('import postgres from "postgres";\nimport { config } from "./config.ts";', 'import type postgres from "postgres";\nimport type { Database } from "@amp/config";\nimport { dbOf } from "./module-db.ts";')
start = text.index('// int8 and numeric')
end = text.index('export type Sql = typeof sql;') + len('export type Sql = typeof sql;')
text = text[:start] + 'export type Sql = Database;' + text[end:]
text = text.replace('return sql.begin(async (tx) => {', 'return dbOf("publication").begin(async (tx) => {')
texts[name] = text.replace('await Promise.all([closeProcessDb(), sql.end({ timeout: 5 })]);', 'await closeProcessDb();')

for name, text in texts.items():
    (root / name).write_text(text)
print(f'Rewrote {len(mapping["files"])} global imports and {len(texts)} files; base {mapping["base_sha"]}')
