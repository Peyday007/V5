# Intake process

The machine-readable form is `intake-schema.json`.

## Flow, with service levels in business days

1. **Day 0: intake.** The attorney, or the client with the attorney copied,
   submits the form. Brain validates it against the schema. If anything is
   missing, Brain asks for it the same business day. The clock starts only
   when the intake is complete.
2. **Day 0: invoice.**
   - Repeat firm or direct client: the invoice is paid now, and work starts
     on payment.
   - A firm's first order: no payment now (pay on approval; see PAYMENTS.md).
3. **Day 1–2: financial model preview.** Revenue drivers, hiring plan and
   5-year statements go to the attorney, so the numbers are agreed before the
   prose.
4. **Day 4: specialist review** against the QA checklist (SPECIALIST.md),
   then fixes.
5. **Day 5: full draft delivered** (Word + PDF + the model as CSV/XLSX).
6. **Revisions.** Unlimited within 30 days of delivery. Each turnaround is
   within 2 business days.
7. **Approval.** The attorney approves in writing; that date is recorded in
   the ledger as an obligation milestone.

## What intake must collect

- **Attorney:** name, firm, bar state, email, preferred plan structure or
  template (optional upload).
- **Investor:** name, treaty nationality (validated against the State
  Department treaty country list), ownership %, role, CV (upload).
- **Business:** legal name, entity type, state, city, NAICS or description,
  new / purchase / franchise, address or target area, lease status.
- **Investment:** total committed, spent to date, itemized uses, source of
  funds summary. The documents themselves stay with the attorney; the plan
  references them.
- **Operations:** products or services, prices, hours, suppliers, existing
  contracts or letters of intent.
- **Hiring:** planned roles, the offered salary or hourly rate, start month.
- **Financial starting points:** the investor's own estimates of volumes, rent
  and margins, if any.
- **Timeline:** filing or interview date (drives priority), consulate or
  USCIS.
- **Consent:** permission to process data with AI tools and one named
  reviewer under NDA; no reuse.

## Refusals at intake

Brain declines, and says why, when:
- the requested deadline is under 5 business days;
- the client wants a guarantee of approval;
- the source of funds is undisclosed;
- the business is not legal in the state.
