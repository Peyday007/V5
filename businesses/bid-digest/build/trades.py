"""Trades, set-aside families and neighbouring states: the vocabulary a customer profile is written in."""

# trade key -> (plain label, NAICS codes the trade bids under)
TRADES = {
    'janitorial':   ('janitorial and custodial services', ['561720', '561790']),
    'landscaping':  ('landscaping and grounds maintenance', ['561730']),
    'facilities':   ('facilities support services', ['561210']),
    'security':     ('security guard and patrol services', ['561612', '561621']),
    'staffing':     ('staffing and temporary help', ['561320', '561311']),
    'it':           ('IT and computer services', ['541511', '541512', '541519']),
    'construction': ('commercial building construction', ['236220', '236210']),
    'electrical':   ('electrical contracting', ['238210']),
    'hvac':         ('HVAC and plumbing', ['238220']),
    'roofing':      ('roofing', ['238160']),
    'sitework':     ('paving, sitework and excavation', ['237310', '238910']),
    'pest':         ('pest control', ['561710']),
    'waste':        ('waste collection and hauling', ['562111', '562119']),
    'engineering':  ('engineering services', ['541330']),
    'painting':     ('painting and wall covering', ['238320']),
    'specialty':    ('specialty trade contracting', ['238990']),
    'repair':       ('commercial equipment repair and maintenance', ['811310']),
    'moving':       ('moving and relocation', ['484210']),
}

# SAM.gov SetASideCode -> family. A customer profile lists the families it is certified for.
SETASIDE_FAMILY = {
    'SBA': 'small business', 'SBP': 'small business', 'ESB': 'small business',
    '8A': '8(a)', '8AN': '8(a)',
    'WOSB': 'WOSB', 'WOSBSS': 'WOSB', 'EDWOSB': 'WOSB', 'EDWOSBSS': 'WOSB',
    'SDVOSBC': 'SDVOSB', 'SDVOSBS': 'SDVOSB', 'VSA': 'SDVOSB', 'VSS': 'SDVOSB',
    'HZC': 'HUBZone', 'HZS': 'HUBZone',
    'ISBEE': 'Indian', 'IEE': 'Indian', 'BICiv': 'Indian',
    'LAS': 'local area',
}
# Every certified family also qualifies for a plain small-business set-aside.
FAMILIES = ['small business', '8(a)', 'WOSB', 'SDVOSB', 'HUBZone', 'Indian', 'local area']

NEIGHBORS = {
    'AL': 'FL GA MS TN', 'AZ': 'CA NM NV UT', 'AR': 'LA MO MS OK TN TX', 'CA': 'AZ NV OR',
    'CO': 'KS NE NM OK UT WY', 'CT': 'MA NY RI', 'DE': 'MD NJ PA', 'DC': 'MD VA',
    'FL': 'AL GA', 'GA': 'AL FL NC SC TN', 'ID': 'MT NV OR UT WA WY', 'IL': 'IN IA KY MO WI',
    'IN': 'IL KY MI OH', 'IA': 'IL MN MO NE SD WI', 'KS': 'CO MO NE OK', 'KY': 'IL IN MO OH TN VA WV',
    'LA': 'AR MS TX', 'ME': 'NH', 'MD': 'DC DE PA VA WV', 'MA': 'CT NH NY RI VT',
    'MI': 'IN OH WI', 'MN': 'IA ND SD WI', 'MS': 'AL AR LA TN', 'MO': 'AR IA IL KS KY NE OK TN',
    'MT': 'ID ND SD WY', 'NE': 'CO IA KS MO SD WY', 'NV': 'AZ CA ID OR UT', 'NH': 'MA ME VT',
    'NJ': 'DE NY PA', 'NM': 'AZ CO OK TX', 'NY': 'CT MA NJ PA VT', 'NC': 'GA SC TN VA',
    'ND': 'MN MT SD', 'OH': 'IN KY MI PA WV', 'OK': 'AR CO KS MO NM TX', 'OR': 'CA ID NV WA',
    'PA': 'DE MD NJ NY OH WV', 'RI': 'CT MA', 'SC': 'GA NC', 'SD': 'IA MN MT ND NE WY',
    'TN': 'AL AR GA KY MO MS NC VA', 'TX': 'AR LA NM OK', 'UT': 'AZ CO ID NV WY',
    'VT': 'MA NH NY', 'VA': 'DC KY MD NC TN WV', 'WA': 'ID OR', 'WV': 'KY MD OH PA VA',
    'WI': 'IA IL MI MN', 'WY': 'CO ID MT NE SD UT', 'HI': '', 'AK': '',
}


def with_neighbors(state):
    return [state] + NEIGHBORS.get(state, '').split()
