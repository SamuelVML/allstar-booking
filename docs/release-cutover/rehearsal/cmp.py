import sqlite3,json,sys,glob,hashlib
db=sqlite3.connect(':memory:')
for f in sorted(glob.glob('migrations/000[0-7]_*.sql')):
    db.executescript(open(f).read().replace('--> statement-breakpoint',''))
db.executescript(open('seed.sql').read())
ok=True
for t in sys.argv[1:]:
    cols=[r[1] for r in db.execute(f'PRAGMA table_info({t})') if r[1] not in ('created_at','updated_at')]
    loc=sorted(json.dumps([r[i] for i in range(len(cols))]) for r in db.execute(f'SELECT {",".join(cols)} FROM {t}'))
    rem=json.load(open(f'remote-{t}.json'))[0]['results']
    rem=sorted(json.dumps([r[c] for c in cols]) for r in rem)
    same=loc==rem; ok&=same
    print(f"{t:18} local {len(loc):4} remote {len(rem):4} {'MATCH' if same else 'MISMATCH'} sha {hashlib.sha256(''.join(rem).encode()).hexdigest()[:12]}")
print('ALL PRE-EXISTING DATA PRESERVED' if ok else 'DATA MISMATCH')
