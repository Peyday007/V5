// E-014: where Brain's standing operating-model sentence lands in the route prompt, the critic prompt, the direction prompt and the discovery question.
import { OPERATING_MODEL_SENTENCE, ownerLabourOffer } from '../../../../../server/domain/operatingModel.ts';
import { routePrompt, critiquePrompt, directionPrompt, directMeansLine, type RouteContext } from '../../../../../server/services/goals/routeProposal.ts';
import { discoveryFocusFor, questionFor, goalBucket, executionFrameSentence, REMOTE_AI_FOCUS } from '../../../../../server/services/cash/discovery.ts';
import { DELIVERS, TODAY, write } from './lib.ts';

const owners: Record<string, string> = {
  a_labourEquipment_p02: "I have a DJI Mavic 3 and my FAA Part 107 license, I'm in Phoenix. I want to clear $4,500 from drone work in the next 60 days. I can spend $1,500 and I can fly about 20 hours a week.",
  a_labour_p06: 'Seattle. I have zero money to invest and I need $500 within 7 days. I can put in 15 hours this week. Figure out the fastest legit way.',
  b_nothing: 'I want $3,000 in 60 days and I have $1,000 to invest.',
  c_refusesPhysical: "I want $5,000 in 90 days with $2,000 to invest. I won't do any physical work myself.",
  c_noHours_p10: "I want a business that does $20,000 in the next 90 days and keeps going after. I'm in Minneapolis, I have $5,000 to fund it, and I can't put any hours in myself at all, so it has to run without me. Choose whatever you think works.",
  // C03-F offer-detection probes (phrasings the regex may miss)
  f_evenings: "I can only spare a couple of evenings a week, I'm in Denver and I want $1,500 in 45 days with $300.",
  f_pressureWasher: 'Got a pressure washer and my Saturdays. Need $800 in 30 days, no money to put in.',
  f_licensedElectrician: "I'm a licensed electrician in Columbus. I want an extra $4,000 in 60 days on the side with $500.",
  f_happyToDrive: "I don't mind driving or doing deliveries. Need $600 in two weeks, zero budget.",
};
const STANDING_MARK = 'the owner does no physical work';
const frame = { delivers: DELIVERS, deployableCents: 0, currency: 'USD' };
const out: any = {};
for (const [k, words] of Object.entries(owners)) {
  const labour = ownerLabourOffer(words);
  const ctx: RouteContext = { objective: words, currency: 'USD', remaining: 1000, daysLeft: 60, capitalLimit: 1000, hoursLimit: null, hoursPerWeek: null, resources: null, industry: null, recurring: false, exclusions: [], delivers: DELIVERS, held: [], refuted: [], today: TODAY, ownerLabour: labour, findings: [], scouted: [], lessons: [] };
  const rp = routePrompt(ctx);
  const limits = rp.slice(rp.indexOf('LIMITS'), rp.indexOf('FEASIBILITY'));
  const opLine = limits.split('\n').find((l) => /operation is run entirely online|owner offered their own work/.test(l)) ?? null;
  const cp = critiquePrompt(ctx, [], null);
  const dp = directionPrompt(ctx);
  const focus = discoveryFocusFor(words);
  const qNull = questionFor(goalBucket('g1', words, `Which ways could bring this operation money? ${focus}`, 'lens'), words, 1, [], { lines: [], omitted: 0 }, null);
  const qFrame = questionFor(goalBucket('g1', words, `Which ways could bring this operation money? ${focus}`, 'lens'), words, 1, [], { lines: [], omitted: 0 }, frame);
  out[k] = {
    labour,
    routePrompt: { operatingLine: opLine, standingSentenceInLimits: limits.includes(OPERATING_MODEL_SENTENCE), standingMarkAnywhere: rp.includes(STANDING_MARK), directMeans: directMeansLine(ctx) || null },
    critiquePrompt: { standingSentence: cp.includes(OPERATING_MODEL_SENTENCE), standingMarkAnywhere: cp.includes(STANDING_MARK) },
    directionPrompt: { standingSentence: dp.includes(OPERATING_MODEL_SENTENCE), standingMarkAnywhere: dp.includes(STANDING_MARK) },
    discovery: {
      focusIsOnlineOnly: focus === REMOTE_AI_FOCUS, focusHead: focus.slice(0, 160),
      questionNoFrame_hasStandingSentence: qNull.includes(OPERATING_MODEL_SENTENCE),
      questionWithFrame_hasStandingSentence: qFrame.includes(OPERATING_MODEL_SENTENCE),
      questionWithFrame_saysNoPhysicalPresence: qFrame.includes('local physical presence'),
      questionWithFrame_excludesHourlyPositions: /hourly positions/.test(qFrame),
      bothLiftAndStandingInSameQuestion: labour.offered && qFrame.includes('owner offered their own work') && qFrame.includes(STANDING_MARK),
    },
  };
}
const sample = questionFor(goalBucket('g1', owners.a_labour_p06!, `Which ways could bring this operation money? ${discoveryFocusFor(owners.a_labour_p06)}`, 'lens'), owners.a_labour_p06!, 1, [], { lines: [], omitted: 0 }, frame);
write('raw/E-014/result.json', out);
write('raw/E-014/discovery_question_p06_with_frame.txt', sample);
write('raw/E-014/execution_frame_sentence.txt', executionFrameSentence(frame));
console.log(JSON.stringify(out, null, 1));
