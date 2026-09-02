#!/usr/bin/env python3
"""Mierzy, ile trafnych zapytan zwraca wynik i ile pulapek zostaje odrzuconych.

Uzycie: evaluate.py <nazwa-prototypu> '<komenda>'
{q} w komendzie zostaje podmienione na zapytanie; wyjsciem ma byc JSON z lista
wynikow albo pusta lista."""
import json,subprocess,sys,os,statistics

_HERE = os.path.dirname(os.path.abspath(__file__))
Z = json.load(open(os.path.join(_HERE, 'zestaw-testowy.json')))

def run(cmd,q):
    try:
        o=subprocess.run(cmd.replace('{q}',q),shell=True,capture_output=True,text=True,timeout=60).stdout
        d=json.loads(o)
        return d if isinstance(d,list) else d.get('results',d.get('documents',[]))
    except Exception as e:
        return None

def ocen(nazwa,cmd):
    tp=fn=tn=fp=0; szcz=[]
    for t in Z['trafne']:
        r=run(cmd,t['q'])
        if r is None: print(f"  BLAD dla: {t['q']}"); continue
        if len(r)>0: tp+=1
        else: fn+=1; szcz.append(('BRAK WYNIKU',t['q']))
    for p in Z['pulapki']:
        r=run(cmd,p['q'])
        if r is None: continue
        if len(r)==0: tn+=1
        else: fp+=1; szcz.append(('FALSZYWE TRAFIENIE',p['q']))
    n=len(Z['trafne']); m=len(Z['pulapki'])
    print(f"\n=== {nazwa} ===")
    print(f"  TRAFNE zwrocily wynik:   {tp}/{n}")
    print(f"  PULAPKI odrzucone:       {tn}/{m}")
    print(f"  WYNIK: {tp+tn}/{n+m}")
    for typ,q in szcz: print(f"    {typ}: {q}")
    return tp+tn

if __name__=='__main__':
    if len(sys.argv)<3: print(__doc__); sys.exit(1)
    ocen(sys.argv[1],sys.argv[2])
