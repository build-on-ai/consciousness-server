#!/usr/bin/env python3
"""Bramka dwusygnalowa: zapytanie musi trafic w slownictwo korpusu i w temat dokumentow.

Uzycie:   memory_search.py "zapytanie" [--json]
Zmienne:  RECALL_EMBED_MODEL, RECALL_CACHE_DIR, RECALL_CHROMA_PATH, OLLAMA_URL,
          MEMORY_MIN_LEX, MEMORY_MIN_TOPIC, MEMORY_LIMIT
"""
import sys, os, re, json
def main():
    q = sys.argv[1] if len(sys.argv) > 1 else ""
    as_json = '--json' in sys.argv
    out = []
    try:
        import numpy as np
        from collections import Counter
        import urllib.request
        MIN_LEX = int(os.environ.get('MEMORY_MIN_LEX', 1))
        MIN_TOP = float(os.environ.get('MEMORY_MIN_TOPIC', 0.32))
        LIMIT   = int(os.environ.get('MEMORY_LIMIT', 3))
        EMBED_MODEL = os.environ.get('RECALL_EMBED_MODEL', 'snowflake-arctic-embed2')
        CACHE_DIR = os.environ.get('RECALL_CACHE_DIR',
                        os.path.join(os.path.expanduser('~'), '.cache', 'cs-recall'))
        os.makedirs(CACHE_DIR, exist_ok=True)
        CACHE   = os.path.join(CACHE_DIR, 'embeddings.npz')
        if os.path.exists(CACHE):
            z = np.load(CACHE, allow_pickle=True); M = list(z['M']); N = z['N']
        else:
            import chromadb
            col = chromadb.PersistentClient(path=os.environ.get('RECALL_CHROMA_PATH','./data/chroma')).get_collection(os.environ.get('RECALL_COLLECTION','notes_arctic'))
            g = col.get(limit=col.count(), include=['embeddings','metadatas'])
            M = [m or {} for m in g['metadatas']]
            E = np.array(g['embeddings'], dtype=np.float32)
            N = E/np.linalg.norm(E, axis=1, keepdims=True)
            np.savez(CACHE, M=np.array(M, dtype=object), N=N, model=EMBED_MODEL)
        _here = os.path.dirname(os.path.abspath(__file__))
        _vf = next((f for f in (os.path.join(_here, 'vocab.json'),
                                os.path.join(_here, 'vocab.example.json'))
                    if os.path.exists(f)), None)
        vocab = Counter(json.load(open(_vf, encoding='utf-8'))) if _vf else Counter()
        for m in ([] if vocab else M):
            if not isinstance(m, dict): continue
            for f in ('topic','subject'):
                for w in re.findall(r'\w{4,}', str(m.get(f,'')).lower()): vocab[w] += 1
        lex = sum(1 for w in set(re.findall(r'\w{4,}', q.lower())) if vocab.get(w,0) >= 2)
        if lex >= MIN_LEX:
            def emb(t):
                r = urllib.request.Request(os.environ.get('OLLAMA_URL','http://localhost:11434')+'/api/embeddings',
                    data=json.dumps({'model':EMBED_MODEL,'prompt':t}).encode(),
                    headers={'Content-Type':'application/json'})
                v = np.array(json.loads(urllib.request.urlopen(r, timeout=3).read())['embedding'])
                return v/np.linalg.norm(v)
            qv = emb(q)
            tops = sorted({str(m.get('topic')) for m in M if isinstance(m,dict) and m.get('topic')})
            TC = os.path.join(CACHE_DIR, 'topics.npz')
            T = None
            if os.path.exists(TC):
                z2 = np.load(TC, allow_pickle=True)
                if list(z2['tops']) == tops: T = z2['T']
            if T is None:
                T = np.array([emb(t) for t in tops]); np.savez(TC, T=T, tops=np.array(tops, dtype=object))
            sims = T @ qv
            if float(sims.max()) >= MIN_TOP:
                order = [i for i in np.argsort(-sims)[:12] if sims[i] >= MIN_TOP]
                tw = {tops[i]: float(sims[i]) for i in order}
                if N.shape[1] != qv.shape[0]:
                    sys.stderr.write('recall: BLAD KONFIGURACJI - wektory w bazie maja wymiar %d, model %s zwraca %d.\nBaza zostala zbudowana innym modelem. Przebuduj kolekcje albo ustaw RECALL_EMBED_MODEL na model uzyty do jej budowy.\n' % (N.shape[1], EMBED_MODEL, qv.shape[0]))
                    sys.exit(2)
                doc = N @ qv
                cand = [(float(doc[i]) + 0.15*tw[str(M[i].get('topic'))], M[i]) for i in range(len(M))
                        if isinstance(M[i],dict) and str(M[i].get('topic')) in tw]
                cand.sort(key=lambda x: -x[0]); seen = set()
                for sc, m in cand:
                    k = (str(m.get('topic')), str(m.get('subject')))
                    if k in seen: continue
                    seen.add(k)
                    out.append({'date': str(m.get('created_at',''))[:10],
                                'topic': str(m.get('topic') or m.get('title','')),
                                'subject': str(m.get('subject','')), 'score': round(sc,3)})
                    if len(out) >= LIMIT: break
    except SystemExit:
        raise
    except Exception as e:
        sys.stderr.write('recall: %s: %s\n' % (type(e).__name__, e))
    if as_json: print(json.dumps(out, ensure_ascii=False))
    else:
        for o in out:
            print(f"- [{o['date']}] {o['topic'][:60]}" + (f" — {o['subject'][:70]}" if o['subject'] else ""))
main()
