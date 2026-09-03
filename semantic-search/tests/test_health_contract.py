#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Kontrakt /health: stan bloku i stan Ollamy to dwa osobne pola.

Powod istnienia: monitoring w kontenerze nie widzi Ollamy nasluchujacej na
127.0.0.1 hosta i oznaczal ja jako awarie. Stan Ollamy raportuje ten blok, bo
dziala w trybie hosta i jako jedyny ja widzi — ale osobnym polem. Kontener moze
byc zdrowy przy chwilowo niedostepnym modelu, a monitor, ktory tego nie
rozroznia, uczy ludzi ignorowac czerwone wpisy.

Uruchomienie: python3 semantic-search/tests/test_health_contract.py
"""
import os
import re
import sys

KATALOG = os.path.dirname(os.path.abspath(__file__))
ZRODLO = os.path.join(KATALOG, '..', 'server.py')

blad = 0


def sprawdz(warunek, opis):
    global blad
    if not warunek:
        blad += 1
        print(f"FAIL {opis}", file=sys.stderr)


src = open(ZRODLO, encoding='utf-8').read()

# --- kontrakt odpowiedzi ---
health = re.search(r"def health\(\):(.*?)\n\n", src, re.S)
sprawdz(health is not None, "nie znaleziono health() w server.py")
if health:
    tresc = health.group(1)
    sprawdz("'status': 'ok'" in tresc, "/health nie zwraca pola status")
    sprawdz("'ollama': probe_ollama()" in tresc, "/health nie zwraca pola ollama")

# --- stan Ollamy nie moze wplywac na status bloku ---
probe = re.search(r"^def probe_ollama\(\):.*?(?=^@app\.route)", src, re.S | re.M)
sprawdz(probe is not None, "nie znaleziono probe_ollama()")
if probe:
    tresc = probe.group(0)
    sprawdz("'reachable': False" in tresc, "probe_ollama nie raportuje niedostepnosci")
    sprawdz("'reachable': True" in tresc, "probe_ollama nie raportuje dostepnosci")
    sprawdz("embedding_model_pulled" in tresc,
            "probe_ollama nie sprawdza, czy model osadzen jest pobrany")
    # Docstring wycinamy jawnie: filtr po pierwszym znaku linii zjadal takze
    # kod zaczynajacy sie apostrofem, wiec przepuszczal wlasnie to naruszenie.
    potrojny = chr(34) * 3
    kod = re.sub(potrojny + '.*?' + potrojny, '', tresc, flags=re.S)
    sprawdz("'status':" not in kod,
            "probe_ollama zwraca pole status — stan zaleznosci ma byc osobny")

# --- zachowanie funkcji na trzech odpowiedziach Ollamy ---
sys.path.insert(0, os.path.join(KATALOG, '..'))


class OdpowiedzUdawana:
    def __init__(self, status_code, payload=None, psuj=False):
        self.status_code = status_code
        self._payload = payload
        self._psuj = psuj

    def json(self):
        if self._psuj:
            raise ValueError("nie JSON")
        return self._payload


def uruchom_probe(odpowiedz=None, wyjatek=None):
    """Odtwarza probe_ollama() na podstawionym requests.get, bez sieci."""
    import types
    przestrzen = {
        'requests': types.SimpleNamespace(
            get=(lambda *a, **k: (_ for _ in ()).throw(wyjatek) if wyjatek else odpowiedz),
            exceptions=types.SimpleNamespace(RequestException=Exception),
        ),
        'OLLAMA_URL': 'http://127.0.0.1:11434',
        'EMBEDDING_MODEL': 'nomic-embed-text',
    }
    exec(compile(probe.group(0), 'probe', 'exec'), przestrzen)
    return przestrzen['probe_ollama']()


wynik = uruchom_probe(wyjatek=Exception("brak polaczenia"))
sprawdz(wynik['reachable'] is False, "zatrzymana Ollama ma dac reachable=False")
sprawdz(wynik['reason'] == 'unreachable', "zatrzymana Ollama ma podac powod")

wynik = uruchom_probe(OdpowiedzUdawana(200, {'models': [{'name': 'nomic-embed-text:latest'}]}))
sprawdz(wynik['reachable'] is True, "dzialajaca Ollama ma dac reachable=True")
sprawdz(wynik['embedding_model_pulled'] is True, "model osadzen ma byc rozpoznany")

wynik = uruchom_probe(OdpowiedzUdawana(200, {'models': [{'name': 'gemma4:e4b'}]}))
sprawdz(wynik['reachable'] is True, "Ollama bez modelu osadzen nadal odpowiada")
sprawdz(wynik['embedding_model_pulled'] is False, "brak modelu osadzen ma byc widoczny")
sprawdz(wynik['reason'] == 'embedding_model_missing', "brak modelu ma podac powod")

if blad:
    print(f"\n{blad} przypadkow nie przeszlo", file=sys.stderr)
    sys.exit(1)
print("ok - kontrakt /health: status bloku i stan ollama sa rozdzielone")
