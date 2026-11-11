"""The SAM.gov Contract Opportunities public extract: download once a day, reduce to open notices.

The extract is published by GSA on data.gov with no key. Every row in it is marked Active=Yes,
so "open" is decided here: a biddable notice type whose ResponseDeadLine is still in the future.
"""
import os, re, subprocess, sys, time
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(os.path.dirname(HERE), '.cache')
URL = 'https://s3.amazonaws.com/falextracts/Contract%20Opportunities/datagov/ContractOpportunitiesFullCSV.csv'
RAW = os.path.join(CACHE, 'opps.csv')
OPEN = os.path.join(CACHE, 'open.pkl')
CA = '/root/.ccr/ca-bundle.crt'
BIDDABLE = ['Combined Synopsis/Solicitation', 'Solicitation', 'Presolicitation', 'Sources Sought']
COLS = ['NoticeId', 'Title', 'Sol#', 'Department/Ind.Agency', 'Sub-Tier', 'Office', 'PostedDate', 'Type',
        'SetASideCode', 'SetASide', 'ResponseDeadLine', 'NaicsCode', 'ClassificationCode', 'PopCity', 'PopState',
        'PopZip', 'PopCountry', 'City', 'State', 'Link', 'Description']


def refresh(max_age_h=20):
    os.makedirs(CACHE, exist_ok=True)
    if not os.path.exists(RAW) or time.time() - os.path.getmtime(RAW) > max_age_h * 3600:
        print('downloading SAM.gov extract ...', file=sys.stderr)
        cmd = ['curl', '-sS', '--fail', '-o', RAW + '.part', URL]
        if os.path.exists(CA):
            cmd[1:1] = ['--cacert', CA]
        subprocess.run(cmd, check=True)
        os.replace(RAW + '.part', RAW)
    if not os.path.exists(OPEN) or os.path.getmtime(OPEN) < os.path.getmtime(RAW):
        reduce_open()


def reduce_open():
    df = pd.read_csv(RAW, encoding='cp1252', dtype=str, keep_default_na=False, usecols=COLS)
    df['deadline'] = pd.to_datetime(df['ResponseDeadLine'], utc=True, errors='coerce', format='ISO8601')
    df['posted'] = pd.to_datetime(df['PostedDate'], errors='coerce')
    df = df[df['Type'].isin(BIDDABLE) & df['deadline'].notna()]
    df['SetASideCode'] = df['SetASideCode'].str.replace(r'[\[\]"]', '', regex=True).str.strip()
    df['Description'] = df['Description'].str.slice(0, 700)
    # one row per solicitation number: a presolicitation and its solicitation are one opportunity
    df = df.sort_values('posted', ascending=False)
    keyed = df[df['Sol#'].str.strip() != '']
    df = pd.concat([keyed.drop_duplicates(['Sol#', 'Department/Ind.Agency']), df[df['Sol#'].str.strip() == '']])
    df.attrs['extract_mtime'] = os.path.getmtime(RAW)
    df.to_pickle(OPEN)


def load_open(now=None):
    refresh()
    df = pd.read_pickle(OPEN)
    now = now or pd.Timestamp.now(tz='UTC')
    return df[df['deadline'] > now].copy(), pd.Timestamp(os.path.getmtime(RAW), unit='s', tz='UTC')
