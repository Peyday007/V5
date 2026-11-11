"""Which open notices a customer profile matches, and the one-line fact the outreach teaser quotes."""
import pandas as pd
from trades import TRADES, SETASIDE_FAMILY, with_neighbors

SB_PROGRAMS = {'small business', '8(a)', 'WOSB', 'SDVOSB', 'HUBZone'}


def family(code):
    if code in ('', 'NONE'):
        return None
    return SETASIDE_FAMILY.get(code, code)


def profile_naics(p):
    codes = list(p.get('naics', []))
    for t in p.get('trades', []):
        codes += TRADES[t][1]
    return sorted(set(codes))


def profile_states(p):
    states = []
    for s in p.get('states', []):
        states += with_neighbors(s) if p.get('include_neighbors') else [s]
    return list(dict.fromkeys(states))


def where(df, states):
    pop = df['PopState'].isin(states)
    office = (df['PopState'] == '') & df['State'].isin(states)
    return pop | office, pd.Series(['place of performance' if a else 'buying office (no place of performance listed)'
                                    for a in pop], index=df.index)


def match(df, p):
    """Matched, eligible notices for profile p, plus counts of what was left out and why."""
    m = df[df['NaicsCode'].isin(profile_naics(p))].copy()
    if not p.get('nationwide'):
        inside, basis = where(m, profile_states(p))
        m['location_basis'] = basis
        m = m[inside]
    else:
        m['location_basis'] = 'nationwide'
    m['family'] = m['SetASideCode'].map(family)
    held = set(p.get('setasides', []))
    small = bool(held)  # any small-business certification also qualifies for a total/partial SB set-aside
    ok = m['family'].isna() | m['family'].isin(held) | ((m['family'] == 'small business') & small)
    excluded = m[~ok]['family'].value_counts().to_dict()
    return m[ok].sort_values('deadline'), excluded


def teaser(df, trade, state):
    """A computed, quotable fact for a small business in `trade` based in `state` (it and its neighbours)."""
    label, codes = TRADES[trade]
    states = with_neighbors(state)
    m = df[df['NaicsCode'].isin(codes)]
    inside, _ = where(m, states)
    local = m[inside]
    sb = local['SetASideCode'].map(family).isin(SB_PROGRAMS).sum()
    naics = ', '.join(codes)
    area = f'{state} and neighboring states' if len(states) > 1 else state
    opp = lambda n: f'{n} open federal contract opportunit{"y" if n == 1 else "ies"}'
    if len(local) == 0:
        return (f'{opp(len(m))} for {label} (NAICS {naics}) nationwide right now', 0, len(m), 0)
    tail = f'{sb} of them set aside for small businesses' if len(local) > 1 else \
        ('it is set aside for small businesses' if sb else 'it is open to all bidders')
    return (f'{opp(len(local))} for {label} (NAICS {naics}) with work in {area} right now, {tail}',
            len(local), len(m), int(sb))
