/**
 * Every Brain business that sells through the owner's Instantly workspace, as
 * Sellbird's sales mind reads it (§107): the campaigns it sends through, what
 * it offers and to whom, who signs, and what Brain may do on its own.
 *
 * The facts here are the businesses' own (the Neighbor Card's campaign and
 * sales kit, `businesses/<name>/offer.json` and `campaign.py`, Brain's buyer
 * outreach): Sellbird's writer and reply handler may say only what they say,
 * and the grounding check holds any answer quoting a figure that is not here.
 *
 * `answer` is whether Brain may answer a reply on that business's campaigns by
 * itself. It is on only for campaigns Brain operates under the owner's standing
 * authorization (the Neighbor Card's activation, 2026-11-11; the CONTACT_BUYER
 * grant for Brain's own campaign). The owner's own campaigns (AI Dispatch) are
 * read, analysed and kept suppressed, never answered: Brain never changes a
 * campaign it did not create (§94).
 *
 * `deliverable` names what an accepted offer needs that Brain cannot put in a
 * text reply (an image, a PDF, a generated sample): such a reply is held for
 * fulfilment, never answered with a promise.
 */
import { BRAIN_CAMPAIGN_NAME } from '../cash/providers/instantly.ts';
import { CAMPAIGN_NAME, PERSONAL_CAMPAIGN_NAME, PUBLISHER, PUBLISHER_ADDRESS, PUBLISHER_PHONE } from '../cash/neighborCard.ts';
import type { SalesOffer } from '../agents/sellbird.ts';

export interface SalesBusiness {
  id: string;
  /** The Instantly campaigns it sends through, by exact name. */
  campaigns: string[];
  offer: SalesOffer;
  /** Brain may answer replies on these campaigns by itself (see the header). */
  answer: boolean;
  /** What an accepted offer needs that a text reply cannot carry, or null. */
  deliverable: string | null;
  /** Brain researches and writes each first email for new leads (the personal variant). */
  personal: boolean;
}


const OPT_OUT = 'Reply "no thanks" and we won\'t contact you again.';

const NEIGHBOR_CARD_KNOWLEDGE = [
  'The Neighbor Card is a 9x12 postcard of local offers that USPS delivers to 4,944 homes in Camp Hill and East Hampden (ZIP 17011, 11 whole carrier routes, homes only) on January 4, 2027.',
  'Where the homes are: Camp Hill borough 2,804 homes (57%), Hampden Township 1,565 (32%), East Pennsboro Township 431 (9%), Lemoyne 140 (3%).',
  'The carrier routes have a USPS-counted median household income of about $109k.',
  'One business per category on each card. A standard spot is $295 (about 6 cents a home) and the ad design is free.',
  'The card prints only if 10 of its 22 ad cells are paid by December 9; otherwise every advertiser gets a full refund by December 11.',
  'January is when people book the dentist, join a gym and fix the furnace.',
  'Materials a prospect can ask for: the front and back of the actual card, the route map and the one-page rate card. They are images and a PDF, which the publisher sends.',
  'To take a spot, the advertiser replies yes and receives the order form and a secure payment link.',
].join('\n');

export const SALES_BUSINESSES: SalesBusiness[] = [
  {
    id: 'neighbor-card',
    campaigns: [CAMPAIGN_NAME, PERSONAL_CAMPAIGN_NAME],
    answer: true,
    personal: true,
    deliverable: 'the card front and back, the route map and the rate card (images and a PDF)',
    offer: {
      brand: 'The Neighbor Card',
      sender: { name: PUBLISHER, role: 'publisher', tone: 'plain, friendly and brief, like a neighbor' },
      product: {
        name: 'The Neighbor Card',
        description: 'A shared 9x12 postcard of local offers mailed by USPS to 4,944 Camp Hill and East Hampden homes on January 4, one business per category.',
        pricing: '$295 for a standard spot, ad design included; full refund if the card does not fill by December 9.',
        benefits: [
          'reaches 4,944 homes in Camp Hill & East Hampden the week people make January plans',
          'one business per category, so no competitor on the same card',
          'no risk: it prints only if 10 of 22 spots are paid, otherwise a full refund',
          'free ad design',
        ],
        objections: {
          price: 'At $295 it is about 6 cents a home, and it is refunded in full if the card does not fill.',
          'not now': 'January 4 is the one mailing; the spot holds only until the categories fill.',
          proof: 'They can see the actual card front and back and the route map before paying anything.',
        },
        entry: 'the front and back of the actual card, the route map and the one-page rate card',
      },
      industries: ['dental', 'fitness', 'hvac', 'restaurant', 'auto', 'spa', 'chiropractic', 'real estate', 'home services'],
      geography: ['Camp Hill, PA', 'Mechanicsburg, PA', 'Lemoyne, PA', 'Hampden Township, PA'],
      postalAddress: `Published by ${PUBLISHER} · ${PUBLISHER_PHONE} · ${PUBLISHER_ADDRESS}`,
      optOutLine: OPT_OUT,
      phoneNumbers: [PUBLISHER_PHONE],
      knowledge: NEIGHBOR_CARD_KNOWLEDGE,
    },
  },
  {
    id: 'buyer-outreach',
    campaigns: [BRAIN_CAMPAIGN_NAME],
    answer: true,
    personal: false,
    deliverable: null,
    offer: {
      brand: 'Brain',
      sender: { name: PUBLISHER, role: 'owner' },
      product: { name: 'the offer on each deal card', description: 'Each message carries one deal card\'s own offer: its title, scope, price and acceptance condition.' },
      postalAddress: PUBLISHER_ADDRESS,
      optOutLine: OPT_OUT,
      phoneNumbers: [PUBLISHER_PHONE],
      knowledge: 'Each buyer was offered exactly what their message states; nothing else is on offer.',
    },
  },
  {
    id: 'grant-prospects',
    campaigns: ['Grant Prospects · nonprofits wave 1'],
    answer: true,
    personal: false,
    deliverable: 'the organization\'s free grant prospect report (built by businesses/grant-prospects, sent by operate.py fulfill)',
    offer: {
      brand: 'Funder Ledger',
      sender: { name: PUBLISHER, role: 'founder' },
      product: {
        name: 'Grant Prospect Report',
        description: 'A report for one nonprofit: 25-40 best-fit foundations ranked by grants they made to similar organizations, with recipient, amount, purpose, contact and application instructions from the 990-PF, plus open federal opportunities.',
        pricing: '$149 for one report; $49 a month for the new-opportunities update, cancel any time. The first report is free to an organization that replies.',
        benefits: ['built from the funders\' own tax filings', 'shows who actually gave to similar work, not who lists an interest'],
        entry: 'the organization\'s full grant prospect report, free',
      },
      industries: ['nonprofit'],
      postalAddress: PUBLISHER_ADDRESS,
      optOutLine: OPT_OUT,
      phoneNumbers: [PUBLISHER_PHONE],
      knowledge: 'Funder Ledger reads public 990-PF tax filings, Grants.gov and the ProPublica Nonprofit Explorer. It promises no grant and gives no legal advice. Reports are HTML and PDF, delivered within 2 business days.',
    },
  },
  {
    id: 'bid-digest',
    campaigns: ['Bid Digest · contractors wave 1'],
    answer: true,
    personal: false,
    deliverable: 'the contractor\'s free sample digest (built by businesses/bid-digest, sent by operate.py fulfill)',
    offer: {
      brand: 'Weekly Bid Digest',
      sender: { name: PUBLISHER, role: 'founder' },
      product: {
        name: 'Weekly Bid Digest',
        description: 'Every Monday, a digest of open federal solicitations on SAM.gov matching one trade\'s NAICS codes, set-asides and home state plus neighboring states, with who won similar work recently and for how much.',
        pricing: '$49 a month; $99 for up to 3 trades and any states plus mid-week alerts; $79 one-time incumbent and price history report.',
        benefits: ['read from SAM.gov and USAspending every week', 'only the notices that fit the trade and certifications'],
        entry: 'this week\'s digest for their trade, free',
      },
      industries: ['construction', 'electrical', 'hvac', 'landscaping', 'security', 'janitorial'],
      postalAddress: PUBLISHER_ADDRESS,
      optOutLine: OPT_OUT,
      phoneNumbers: [PUBLISHER_PHONE],
      knowledge: 'Data comes from SAM.gov public opportunities and the USAspending API. It is not bid writing and gives no legal advice.',
    },
  },
  {
    id: 'access-audit',
    campaigns: ['Accessibility Audit · small business wave 1'],
    answer: true,
    personal: false,
    deliverable: 'the free homepage accessibility summary (built by businesses/access-audit, sent by operate.py fulfill)',
    offer: {
      brand: 'Tabstop Accessibility Reports',
      sender: { name: PUBLISHER, role: 'founder' },
      product: {
        name: 'Accessibility Audit Report',
        description: 'An automated axe-core scan of up to 10 key pages at desktop and mobile widths plus a scripted keyboard check, every issue in plain English with the fix.',
        pricing: '$149 for the audit report; $29 a month for monthly re-scans. A short homepage summary is free to anyone who replies.',
        benefits: ['finds what blocks screen-reader, keyboard and zoom users', 'most issues are quick fixes for whoever maintains the site'],
        entry: 'a free summary of their homepage scan',
      },
      industries: ['restaurant', 'lodging', 'dental', 'retail', 'salon'],
      postalAddress: PUBLISHER_ADDRESS,
      optOutLine: OPT_OUT,
      phoneNumbers: [PUBLISHER_PHONE],
      knowledge: 'Automated testing finds only part of what a manual audit covers; the reports say so. No legal advice and no compliance guarantee.',
    },
  },
  {
    // The owner's own campaign: read and kept suppressed, never answered (header).
    id: 'ai-dispatch',
    campaigns: ['AI Dispatch'],
    answer: false,
    personal: false,
    deliverable: null,
    offer: {
      brand: 'AI Dispatch',
      sender: { name: PUBLISHER, role: 'owner' },
      product: {
        name: 'AI receptionist for home-service businesses',
        description: 'Answers the calls a trades business misses, asks what the job is and where, and texts the owner the details.',
      },
      industries: ['hvac', 'plumbing', 'pest control', 'electrical', 'tree service'],
      postalAddress: PUBLISHER_ADDRESS,
      optOutLine: OPT_OUT,
      phoneNumbers: [PUBLISHER_PHONE],
    },
  },
];

export function businessForCampaign(name: string): SalesBusiness | null {
  return SALES_BUSINESSES.find((b) => b.campaigns.includes(name)) ?? null;
}

export function salesBusiness(id: string): SalesBusiness | null {
  return SALES_BUSINESSES.find((b) => b.id === id) ?? null;
}
