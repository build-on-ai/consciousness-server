#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Zaleznosci bloku podrozuja razem z jego wpisem, nie jako osobny wiersz.

Powod istnienia: Ollama nasluchuje na 127.0.0.1 hosta, wiec kontener monitorujacy
nigdy jej nie zobaczy i oznaczal ja jako awarie. Nie jest usluga tego stosu —
raportuje ja semantic-search, ktory jako jedyny ja widzi, a monitoring tylko
przepisuje ten stan do wpisu semantic-search.

Uruchomienie: python3 machines-server/tests/test_dependencies.py
"""
import json
import os
import re
import sys

KATALOG = os.path.dirname(os.path.abspath(__file__))
ZRODLO = os.path.join(KATALOG, '..', 'server.py')
REJESTR = os.path.join(KATALOG, '..', '..', 'services.json')

blad = 0


def sprawdz(warunek, opis):
    global blad
    if not warunek:
        blad += 1
        print("FAIL " + opis, file=sys.stderr)


src = open(ZRODLO, encoding='utf-8').read()

rejestr = json.load(open(REJESTR, encoding='utf-8'))
nazwy = [u['name'] for u in rejestr['services']]
sprawdz('ollama' not in nazwy,
        "ollama wrocila do services.json - kontener nigdy jej nie dosiegnie")

sprawdz('_dependencies_from' in src, "brak funkcji przepisujacej zaleznosci")

przestrzen = {'_json': json}
funkcja = re.search(r"^def _dependencies_from\(body\):.*?(?=^def |\Z)", src, re.S | re.M)
sprawdz(funkcja is not None, "nie znaleziono _dependencies_from")
if funkcja:
    exec(compile(funkcja.group(0), 'deps', 'exec'), przestrzen)
    czytaj = przestrzen['_dependencies_from']

    zdrowa = json.dumps({'status': 'ok', 'ollama': {'reachable': True}})
    sprawdz(czytaj(zdrowa) == {'ollama': {'reachable': True}},
            "stan ollama nie zostal przepisany z odpowiedzi /health")

    bez = json.dumps({'status': 'ok'})
    sprawdz(czytaj(bez) is None,
            "blok bez zaleznosci nie moze dostawac pustego pola")

    sprawdz(czytaj(None) is None, "brak odpowiedzi ma dawac None")
    sprawdz(czytaj(b'nie json') is None, "nieparsowalna odpowiedz ma dawac None")

    zdegradowana = json.dumps({'status': 'ok', 'ollama': {'reachable': False}})
    sprawdz(czytaj(zdegradowana) == {'ollama': {'reachable': False}},
            "niedostepna ollama ma byc widoczna jako zaleznosc")

wpis = re.search(r"entry = \{.*?\}", src, re.S)
sprawdz(wpis is not None, "nie znaleziono budowy wpisu uslugi")
if wpis:
    sprawdz("'status': status" in wpis.group(0),
            "status wpisu nie pochodzi juz z sondy")
    sprawdz('dependencies' not in wpis.group(0),
            "zaleznosci trafily do tego samego slownika co status")

if blad:
    print("\n" + str(blad) + " przypadkow nie przeszlo", file=sys.stderr)
    sys.exit(1)
print("ok - zaleznosci bloku sa osobne od jego statusu")
