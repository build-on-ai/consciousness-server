#!/usr/bin/env python3
"""Wybiera tekst do osadzenia zaleznie od klasy dokumentu."""
import re

_USER = re.compile(r'\[USER\](.*?)(?=\[ASSISTANT\]|\[USER\]|$)', re.S)


def classify(doc):
    """transcript | knowledge — po obecnosci znacznikow rozmowy."""
    c = doc.get('content', '') or ''
    if '[ASSISTANT]' in c or '[USER]' in c:
        return 'transcript'
    return 'knowledge'


def text_for_embedding(doc):
    """Zwraca (tekst, klasa), albo (None, klasa) gdy dokumentu nie nalezy osadzac."""
    kind = classify(doc)
    content = doc.get('content', '') or ''

    if kind == 'knowledge':
        title = (doc.get('title') or '').strip()
        return ((title + '\n' + content).strip() or None), kind

    parts = [m.group(1).strip() for m in _USER.finditer(content)]
    text = ' '.join(p for p in parts if p)

    if not text and '[ASSISTANT]' in content:
        head = content.split('[ASSISTANT]')[0].strip()
        if len(head) >= 20:
            text = head

    return (text or None), kind


if __name__ == '__main__':
    import json, sys, collections
    docs = json.load(open(sys.argv[1]))
    docs = docs.get('notes', docs) if isinstance(docs, dict) else docs
    stats = collections.Counter()
    skipped = []
    for d in docs:
        t, k = text_for_embedding(d)
        stats[k if t else k + ':POMINIETY'] += 1
        if not t:
            skipped.append(d.get('id', '?'))
    for k, v in sorted(stats.items()):
        print(f'{k:24} {v}')
    if skipped:
        print(f'\npominietych (do osobnej obslugi): {len(skipped)}')
