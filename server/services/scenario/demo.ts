/**
 * The demonstration model: illustrative, and labelled so on every figure.
 *
 * A productized local service — a bookable job sold at a set price, fulfilled
 * by contractors, employees or a mix — compared across four strategies. It is
 * here so the capability can be exercised end to end without a live Cash
 * transaction, and every input is an ASSUMPTION, a HYPOTHETICAL or an UNKNOWN:
 * none is a sourced fact, so the engine runs it as a sweep and says that its
 * shares are coverage of the tested ranges rather than probabilities.
 *
 * It is not a market claim and must never be read as one. Nothing in it names
 * a real business, a real price or a real supplier.
 */
import type { ScenarioModelDefinition } from '../../domain/scenario.ts';

const ILLUSTRATIVE = 'Illustrative value for the demonstration model, not a sourced fact.';

export const DEMONSTRATION_SEED = 20261008;
export const DEMONSTRATION_EVALUATIONS = 50_000;

export function demonstrationModel(): ScenarioModelDefinition {
  return {
    title: 'Demonstration: productized local service (illustrative)',
    description:
      'A bookable service sold at a fixed price per job and fulfilled by contractors, employees, or both. Every input is illustrative — this model exists to show the engine, not to describe a real market.',
    currency: 'USD',
    horizon: 'six months of operation',
    illustrative: true,
    variables: [
      {
        key: 'price', label: 'Price per job', unit: 'USD', provenance: 'ASSUMPTION', controllable: true,
        spec: { kind: 'RANGE', min: 80, max: 300 }, note: 'A decision each strategy sets.',
      },
      {
        key: 'staffing', label: 'Fulfilment model', unit: '', provenance: 'ASSUMPTION', controllable: true,
        note: 'Payroll, hours, set-up cost and ramp time per model are illustrative.',
        spec: {
          kind: 'CHOICE',
          options: [
            { key: 'CONTRACTOR', label: 'Contractors only', attributes: { payroll: 0, employeeHours: 0, upfront: 1500, rampDays: 7 } },
            { key: 'EMPLOYEE', label: 'Employees only', attributes: { payroll: 7000, employeeHours: 480, upfront: 5000, rampDays: 30 } },
            { key: 'HYBRID', label: 'One employee plus contractors', attributes: { payroll: 3500, employeeHours: 240, upfront: 3000, rampDays: 14 } },
          ],
        },
      },
      {
        key: 'marketing', label: 'Marketing spend per month', unit: 'USD/month', provenance: 'ASSUMPTION', controllable: true,
        spec: { kind: 'RANGE', min: 0, max: 6000 },
      },
      {
        key: 'leads', label: 'Enquiries per month', unit: 'leads/month', provenance: 'HYPOTHETICAL', controllable: false,
        spec: { kind: 'RANGE', min: 100, max: 420 }, note: `At $2,000/month of marketing. ${ILLUSTRATIVE}`,
        responses: [{ to: 'marketing', elasticity: 0.4, reference: 2000, provenance: 'ASSUMPTION', note: 'Diminishing returns to marketing spend; assumed, not measured.' }],
      },
      {
        key: 'conversion', label: 'Enquiries that book', unit: 'share', provenance: 'HYPOTHETICAL', controllable: false,
        spec: { kind: 'RANGE', min: 0.1, max: 0.3 }, note: `At a $150 price. ${ILLUSTRATIVE}`,
        responses: [{ to: 'price', elasticity: -1.3, reference: 150, provenance: 'ASSUMPTION', note: 'Bookings fall as price rises; elasticity assumed.' }],
      },
      {
        key: 'materials', label: 'Materials per job', unit: 'USD/job', provenance: 'HYPOTHETICAL', controllable: false,
        spec: { kind: 'RANGE', min: 15, max: 45 }, note: ILLUSTRATIVE,
      },
      {
        key: 'hoursPerJob', label: 'Labour hours per job', unit: 'hours', provenance: 'HYPOTHETICAL', controllable: false,
        spec: { kind: 'RANGE', min: 1.5, max: 3.5 }, note: ILLUSTRATIVE,
      },
      {
        key: 'contractorRate', label: 'Contractor hourly rate', unit: 'USD/hour', provenance: 'HYPOTHETICAL', controllable: false,
        spec: { kind: 'RANGE', min: 30, max: 55 }, note: ILLUSTRATIVE,
        activeWhen: { variable: 'staffing', in: ['CONTRACTOR', 'HYBRID'], inactiveValue: 0 },
      },
      {
        key: 'contractorHours', label: 'Contractor hours available per month', unit: 'hours/month', provenance: 'UNKNOWN', controllable: false,
        spec: { kind: 'RANGE', min: 60, max: 400 }, note: 'Nobody has established how much contractor time is available; swept.',
        activeWhen: { variable: 'staffing', in: ['CONTRACTOR', 'HYBRID'], inactiveValue: 0 },
      },
      {
        key: 'refundRate', label: 'Revenue refunded', unit: 'share', provenance: 'ASSUMPTION', controllable: false,
        spec: { kind: 'RANGE', min: 0, max: 0.08 }, note: ILLUSTRATIVE,
      },
      {
        key: 'paymentDelay', label: 'Days from job to cash', unit: 'days', provenance: 'HYPOTHETICAL', controllable: false,
        spec: { kind: 'RANGE', min: 5, max: 45 }, note: ILLUSTRATIVE,
      },
      {
        key: 'repeatRate', label: 'Repeat bookings per new customer', unit: 'share', provenance: 'HYPOTHETICAL', controllable: false,
        spec: { kind: 'RANGE', min: 0.05, max: 0.4 }, note: ILLUSTRATIVE,
      },
      {
        key: 'supplier', label: 'Supplier conditions', unit: '', provenance: 'HYPOTHETICAL', controllable: false,
        note: 'Unweighted: each condition is covered equally, because nobody knows how likely each is.',
        spec: {
          kind: 'CHOICE',
          options: [
            { key: 'NORMAL', label: 'Normal', attributes: { costMult: 1, capacityMult: 1, delayDays: 0 } },
            { key: 'STRAINED', label: 'Strained', attributes: { costMult: 1.15, capacityMult: 0.8, delayDays: 7 } },
            { key: 'DISRUPTED', label: 'Disrupted', attributes: { costMult: 1.35, capacityMult: 0.55, delayDays: 21 } },
          ],
        },
      },
      {
        key: 'processingFee', label: 'Card processing fee', unit: 'share of sales', provenance: 'ASSUMPTION', controllable: false,
        spec: { kind: 'FIXED', value: 0.029 }, testRange: { min: 0, max: 0.06 }, note: ILLUSTRATIVE,
      },
      {
        key: 'capitalAvailable', label: 'Capital available', unit: 'USD', provenance: 'ASSUMPTION', controllable: false,
        spec: { kind: 'FIXED', value: 30000 }, note: 'An illustrative ceiling on cash committed before it comes back.',
      },
    ],
    correlations: [
      { a: 'materials', b: 'contractorRate', rho: 0.5, provenance: 'ASSUMPTION', note: 'Both track the same local supply market; assumed.' },
    ],
    derived: [
      { key: 'hoursAvailable', label: 'Hours available per month', unit: 'hours', expr: 'staffing.employeeHours + contractorHours * supplier.capacityMult' },
      { key: 'newJobs', label: 'New bookings per month', unit: 'jobs', expr: 'leads * min(conversion, 0.95)' },
      { key: 'wantedJobs', label: 'Jobs demanded per month', unit: 'jobs', expr: 'newJobs * (1 + repeatRate)' },
      { key: 'jobs', label: 'Jobs done per month', unit: 'jobs', expr: 'min(wantedJobs, hoursAvailable / hoursPerJob)' },
      { key: 'unitCost', label: 'Materials per job after supplier conditions', unit: 'USD', expr: 'materials * supplier.costMult' },
      { key: 'contractorJobHours', label: 'Contractor hours used per month', unit: 'hours', expr: 'max(0, jobs * hoursPerJob - staffing.employeeHours)' },
      { key: 'monthlyOutlay', label: 'Cash out per month', unit: 'USD', expr: 'marketing + staffing.payroll + jobs * unitCost + contractorJobHours * contractorRate' },
      { key: 'cashGapDays', label: 'Days cash is out before it returns', unit: 'days', expr: 'paymentDelay + supplier.delayDays' },
      { key: 'exposure', label: 'Peak capital committed', unit: 'USD', expr: 'staffing.upfront + monthlyOutlay * (staffing.rampDays + cashGapDays) / 30' },
    ],
    lines: [
      { key: 'sales', label: 'Sales', kind: 'REVENUE', expr: 'jobs * price * 6' },
      { key: 'refunds', label: 'Refunds', kind: 'COST', expr: 'jobs * price * 6 * refundRate' },
      { key: 'processing', label: 'Card processing', kind: 'COST', expr: 'jobs * price * 6 * processingFee' },
      { key: 'materialsCost', label: 'Materials', kind: 'COST', expr: 'jobs * unitCost * 6' },
      { key: 'contractorLabor', label: 'Contractor labour', kind: 'COST', expr: 'contractorJobHours * contractorRate * 6' },
      { key: 'payroll', label: 'Payroll', kind: 'COST', expr: 'staffing.payroll * 6' },
      { key: 'marketingSpend', label: 'Marketing', kind: 'COST', expr: 'marketing * 6' },
      { key: 'setup', label: 'Set-up', kind: 'COST', expr: 'staffing.upfront' },
    ],
    metrics: [
      { key: 'capitalExposure', label: 'Peak capital committed', unit: 'USD', expr: 'exposure', better: 'LOWER', role: 'CAPITAL_EXPOSURE' },
      { key: 'daysToCash', label: 'Days to first available cash', unit: 'days', expr: 'staffing.rampDays + cashGapDays', better: 'LOWER', role: 'DAYS_TO_CASH' },
      { key: 'laborHours', label: 'Labour hours over the horizon', unit: 'hours', expr: 'jobs * hoursPerJob * 6', better: 'LOWER', role: 'LABOR_HOURS' },
      { key: 'utilization', label: 'Capacity used', unit: 'share', expr: 'jobs * hoursPerJob / hoursAvailable', better: 'HIGHER', role: 'OTHER' },
    ],
    constraints: [
      { key: 'withinCapital', label: 'Peak capital within what is available', expr: 'exposure - capitalAvailable', op: '<=', value: 0 },
    ],
    strategies: [
      { key: 'premium_contractors', label: 'Premium price, contractors', description: 'High price, modest marketing, no payroll.', set: { price: 220, staffing: 'CONTRACTOR', marketing: 1200 } },
      { key: 'volume_employees', label: 'Volume price, employees', description: 'Low price, heavy marketing, a salaried crew.', set: { price: 130, staffing: 'EMPLOYEE', marketing: 3000 } },
      { key: 'balanced_hybrid', label: 'Balanced, hybrid crew', description: 'Mid price, one employee plus contractors.', set: { price: 165, staffing: 'HYBRID', marketing: 2000 } },
      { key: 'lean_test', label: 'Lean test', description: 'Contractors, little marketing, a small cheap test.', set: { price: 150, staffing: 'CONTRACTOR', marketing: 400 } },
    ],
  };
}
