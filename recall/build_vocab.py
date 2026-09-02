#!/usr/bin/env python3
"""Zbuduj slownik domenowy z wlasnego korpusu.

Wejscie: pliki tekstowe albo JSON z polami tekstowymi (domyslnie topic/subject).
Wyjscie: JSON slowo -> liczba wystapien, posortowany malejaco.

    python3 build_vocab.py korpus/*.txt > vocab.json
    python3 build_vocab.py --json-fields topic,subject dane.json > vocab.json
    python3 build_vocab.py --min-count 3 --min-length 3 korpus/*.txt > vocab.json
"""
import argparse
import collections
import json
import re
import sys
from pathlib import Path

SLOWO = re.compile(r"[0-9a-zà-ſ_]+", re.IGNORECASE)


def teksty_z_pliku(sciezka: Path, pola: list[str]) -> list[str]:
    tresc = sciezka.read_text(encoding="utf-8", errors="replace")
    if sciezka.suffix.lower() != ".json":
        return [tresc]
    try:
        dane = json.loads(tresc)
    except json.JSONDecodeError:
        return [tresc]

    zebrane: list[str] = []

    def obejdz(obiekt):
        if isinstance(obiekt, dict):
            for klucz, wartosc in obiekt.items():
                if klucz in pola and isinstance(wartosc, str):
                    zebrane.append(wartosc)
                else:
                    obejdz(wartosc)
        elif isinstance(obiekt, list):
            for element in obiekt:
                obejdz(element)

    obejdz(dane)
    return zebrane or [tresc]


def policz(teksty, min_dlugosc: int) -> collections.Counter:
    licznik: collections.Counter = collections.Counter()
    for tekst in teksty:
        for dopasowanie in SLOWO.finditer(tekst.lower()):
            slowo = dopasowanie.group(0)
            if len(slowo) >= min_dlugosc:
                licznik[slowo] += 1
    return licznik


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("pliki", nargs="+", type=Path)
    parser.add_argument("--min-count", type=int, default=2,
                        help="pomin hasla rzadsze niz to (domyslnie 2 - jednorazowe to zwykle literowki)")
    parser.add_argument("--min-length", type=int, default=2,
                        help="pomin hasla krotsze niz to (domyslnie 2)")
    parser.add_argument("--json-fields", default="topic,subject",
                        help="pola czytane z plikow JSON, po przecinku")
    args = parser.parse_args()

    pola = [p.strip() for p in args.json_fields.split(",") if p.strip()]
    teksty: list[str] = []
    for sciezka in args.pliki:
        if not sciezka.is_file():
            print(f"build_vocab: pomijam {sciezka} (nie jest plikiem)", file=sys.stderr)
            continue
        teksty.extend(teksty_z_pliku(sciezka, pola))

    if not teksty:
        print("build_vocab: brak tekstu na wejsciu", file=sys.stderr)
        return 1

    licznik = policz(teksty, args.min_length)
    slownik = {s: n for s, n in licznik.most_common() if n >= args.min_count}
    if not slownik:
        print("build_vocab: korpus nie dal ani jednego hasla powyzej progow", file=sys.stderr)
        return 1

    json.dump(slownik, sys.stdout, ensure_ascii=False, indent=1, sort_keys=True)
    sys.stdout.write("\n")
    print(f"build_vocab: {len(slownik)} hasel z {len(teksty)} tekstow", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
