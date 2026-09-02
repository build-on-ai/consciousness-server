
"""Testy podgladu. Uruchomienie: python3 tests/test_preview.py"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
from preview import find_ranges, window_around, preview

ok = fail = 0
def check(name, got, want):
    global ok, fail
    if got == want: ok += 1
    else:
        fail += 1
        print(f'  FAIL {name}\n    oczekiwano: {want}\n    otrzymano:  {got}')

check('puste zapytanie', find_ranges('tekst', ''), [])
check('brak trafien', find_ranges('abc', 'xyz'), [])
check('jedno trafienie', find_ranges('abc def', 'def'), [{'start': 4, 'end': 7}])

check('zakresy rozlaczne', find_ranges('backup nightly', 'backup nightly'),
      [{'start': 0, 'end': 6}, {'start': 7, 'end': 14}])
check('zakresy nakladajace sie -> scalone', find_ranges('backupnightly', 'backup nightly'),
      [{'start': 0, 'end': 13}])
check('to samo slowo dwa razy', find_ranges('ala ma ala', 'ala'),
      [{'start': 0, 'end': 3}, {'start': 7, 'end': 10}])

zly = 'notatka <script>alert(1)</script> i <mark>'
r = preview(zly, 'script')
check('tekst zwrocony bez zmian', r['text'], zly)
check('brak znacznikow w wyjsciu', '<mark>' in str(r['ranges']), False)

dlugi = 'x' * 1000 + 'SZUKANE' + 'y' * 1000
w = window_around(dlugi, find_ranges(dlugi, 'SZUKANE'), 400)
check('okno obejmuje trafienie', w['from'] <= 1000 and w['to'] >= 1007, True)
check('okno nie od zera', w['from'] > 0, True)

r = preview('z' * 300, 'z', max_text=100)
check('truncated oznaczone', r['truncated'], True)
check('tekst faktycznie ucięty', len(r['text']), 100)

r = preview('a ' * 600, 'a')
check('licznik liczy wszystko', r['total_hits'] > 500, True)
check('podswietlanie wylaczone', r['ranges'], [])
check('powod podany jawnie', r['highlight_suppressed'], True)

r = preview('🎉 RELEASE: analytics dashboard is ready', 'dashboard')
check('emoji nie psuje offsetow', r['text'][r['ranges'][0]['start']:r['ranges'][0]['end']].lower(), 'dashboard')

print(f'\nOK: {ok}, FAIL: {fail}')
if __name__ == "__main__":
    sys.exit(1 if fail else 0)
