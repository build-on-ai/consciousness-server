"""Podglad notatki: pelna tresc i zakresy trafien. Zakresy, nie znaczniki HTML."""
import re
from typing import List, Dict, Optional

MAX_HITS_HIGHLIGHT = 500


def find_ranges(text: str, query: str) -> List[Dict[str, int]]:
    """Znajduje trafienia; zwraca zakresy scalone i posortowane."""
    if not text or not query:
        return []
    words = re.findall(r'\w+', query.lower())
    if not words:
        return []
    low = text.lower()
    raw = []
    for w in words:
        start = 0
        while True:
            i = low.find(w, start)
            if i < 0:
                break
            raw.append((i, i + len(w)))
            start = i + 1
    if not raw:
        return []
    raw.sort()
    merged = [list(raw[0])]
    for s, e in raw[1:]:
        if s <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])
    return [{'start': s, 'end': e} for s, e in merged]


def window_around(text: str, ranges: List[Dict[str, int]], size: int = 400) -> Dict[str, int]:
    """Okno wokol pierwszego trafienia: poczatek dlugiego dokumentu to naglowki."""
    if not text:
        return {'from': 0, 'to': 0}
    if not ranges:
        return {'from': 0, 'to': min(len(text), size)}
    pos = ranges[0]['start']
    half = size // 2
    start = max(0, pos - half)
    end = min(len(text), pos + half)
    return {'from': start, 'to': end}


def preview(text: str, query: Optional[str] = None, window: int = 400,
            max_text: int = 200_000) -> Dict:
    """Zwraca pelna tresc + zakresy. NIE zwraca HTML - to robi przegladarka."""
    truncated = False
    if text and len(text) > max_text:
        text = text[:max_text]
        truncated = True
    ranges = find_ranges(text, query) if query else []
    total = len(ranges)
    return {
        'text': text or '',
        'ranges': ranges if total <= MAX_HITS_HIGHLIGHT else [],
        'total_hits': total,
        'highlight_suppressed': total > MAX_HITS_HIGHLIGHT,
        'window': window_around(text, ranges, window),
        'truncated': truncated,
    }
