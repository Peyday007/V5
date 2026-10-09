/**
 * The scenario engine's door.
 *
 * Project-scoped, like every other kernel: `requireProject` is
 * `decideProjectAccess` against the authenticated principal, so another
 * project's model is the same 404 with the same body as one that does not
 * exist (invariant 23), and `requirePerson` refuses a worker by type at the
 * reads as well as the writes. Which level each route needs is declared in
 * `services/identity/policy.ts`; there is no scenario policy module.
 *
 * Nothing here can act on the world. Every result is a labelled simulation,
 * no route writes to the Cash ledger or moves an opportunity, and the
 * demonstration is computed on read and never stored.
 */
import { Router } from 'express';
import {
  badRequest,
  bodyOf,
  handler,
  HttpError,
  notFound,
  optionalString,
  pathId,
  requirePerson,
  requireProject,
  unprocessable,
} from './helpers.ts';
import { SCENARIO_LIMITS, SUMMARY_STATISTICS, VARIABLE_PROVENANCES, type RunOptions, type ScenarioModelDefinition } from '../domain/scenario.ts';
import { archiveScenarioModel, getScenarioModel, getScenarioRun, listScenarioModels, listScenarioRuns, type ScenarioModelRecord } from '../repos/scenario.ts';
import { ScenarioModelError } from '../services/scenario/model.ts';
import { ScenarioRunError } from '../services/scenario/engine.ts';
import { demonstration, normalizeOptions, readRunState, reproduce, reviseModel, runModel, saveModel } from '../services/scenario/service.ts';
import { demonstrationModel } from '../services/scenario/demo.ts';
import { ScenarioBusyError } from '../services/scenario/isolate.ts';

export const scenarioRouter = Router();

const NOT_A_MODEL = 'No scenario model with that id.';

function refusal(error: unknown): never {
  if (error instanceof ScenarioModelError) throw unprocessable(error.message, { problems: error.problems });
  if (error instanceof ScenarioRunError) throw unprocessable(error.message);
  if (error instanceof ScenarioBusyError) throw new HttpError(429, error.message, { retryable: true });
  throw error;
}

async function modelOf(projectId: string, modelId: string): Promise<ScenarioModelRecord> {
  const model = await getScenarioModel(modelId);
  if (!model || model.projectId !== projectId || model.archivedAt) throw notFound(NOT_A_MODEL);
  return model;
}

function definitionFrom(body: Record<string, unknown>): ScenarioModelDefinition {
  const definition = body.definition;
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) throw badRequest('"definition" must be a scenario model object.');
  return definition as ScenarioModelDefinition;
}

function optionsFrom(body: Record<string, unknown>): RunOptions {
  const raw = (body.options ?? {}) as Partial<RunOptions>;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw badRequest('"options" must be an object.');
  if (raw.seed !== undefined && (!Number.isInteger(raw.seed) || raw.seed < 0 || raw.seed > 0xffffffff)) throw badRequest('"options.seed" must be a whole number from 0 to 4294967295.');
  if (raw.evaluations !== undefined && (!Number.isInteger(raw.evaluations) || raw.evaluations < 1 || raw.evaluations > SCENARIO_LIMITS.maxEvaluations)) {
    throw badRequest(`"options.evaluations" must be a whole number from 1 to ${SCENARIO_LIMITS.maxEvaluations}.`);
  }
  if (raw.basis !== undefined && raw.basis !== 'MONTE_CARLO' && raw.basis !== 'SWEEP') throw badRequest('"options.basis" must be MONTE_CARLO or SWEEP.');
  // The rest are checked for shape here, so a malformed option is a refusal
  // naming the field rather than a run that quietly answers something else.
  // Whether a key names a real variable or metric is the engine's to say.
  const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  if (raw.overrides !== undefined) {
    if (!isObject(raw.overrides)) throw badRequest('"options.overrides" must be an object.');
    for (const [key, o] of Object.entries(raw.overrides)) {
      if (!isObject(o) || Object.keys(o).some((k) => k !== 'multiply' && k !== 'value') || (o.multiply === undefined) === (o.value === undefined)
        || (o.multiply !== undefined && !finite(o.multiply)) || (o.value !== undefined && !finite(o.value))) {
        throw badRequest(`"options.overrides.${key}" must carry exactly one finite "multiply" or "value".`);
      }
    }
  }
  if (raw.acceptable !== undefined && (!isObject(raw.acceptable) || !finite(raw.acceptable.minContributionCents))) {
    throw badRequest('"options.acceptable.minContributionCents" must be a finite number.');
  }
  if (raw.objective !== undefined) {
    const o = raw.objective as unknown;
    const statistic = (v: unknown) => typeof v === 'string' && (SUMMARY_STATISTICS as readonly string[]).includes(v);
    if (!isObject(o) || typeof o.metric !== 'string' || !statistic(o.statistic) || (o.direction !== 'MAX' && o.direction !== 'MIN')) {
      throw badRequest('"options.objective" needs a "metric", a "statistic" (MEAN, P10, P50, P90, MIN or MAX) and a "direction" of MAX or MIN.');
    }
    if (o.constraints !== undefined && (!Array.isArray(o.constraints) || !o.constraints.every((c) =>
      isObject(c) && typeof c.metric === 'string' && statistic(c.statistic) && (c.op === '<=' || c.op === '>=') && finite(c.value)))) {
      throw badRequest('"options.objective.constraints" must each carry a "metric", a "statistic", an "op" of <= or >=, and a finite "value".');
    }
  }
  return normalizeOptions(raw);
}

function runView<T extends { state: 'RUNNING' | 'COMPLETE' | 'FAILED'; startedAt: string }>(run: T) {
  return { ...run, reading: readRunState(run) };
}

scenarioRouter.get(
  '/projects/:projectId/scenarios',
  handler(async (req) => {
    requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    return {
      models: (await listScenarioModels(project.id)).map((m) => ({
        id: m.id, title: m.title, illustrative: m.illustrative, updatedAt: m.updatedAt,
        variables: m.definition.variables.length, strategies: m.definition.strategies.length,
      })),
      limits: SCENARIO_LIMITS,
      provenances: VARIABLE_PROVENANCES,
    };
  }),
);

/** The demonstration: computed, read-only, never stored. */
scenarioRouter.get(
  '/projects/:projectId/scenarios/demonstration',
  handler(async (req) => {
    requirePerson();
    await requireProject(pathId(req, 'projectId'));
    try {
      return await demonstration();
    } catch (error) {
      return refusal(error);
    }
  }),
);

scenarioRouter.post(
  '/projects/:projectId/scenarios',
  handler(async (req) => {
    const person = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);
    const definition = body.fromDemonstration === true ? demonstrationModel() : definitionFrom(body);
    try {
      return { model: await saveModel({ projectId: project.id, definition, createdById: person.id }) };
    } catch (error) {
      return refusal(error);
    }
  }),
);

scenarioRouter.get(
  '/projects/:projectId/scenarios/:modelId',
  handler(async (req) => {
    requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const model = await modelOf(project.id, pathId(req, 'modelId'));
    return { model, runs: (await listScenarioRuns(model.id)).map(runView) };
  }),
);

scenarioRouter.patch(
  '/projects/:projectId/scenarios/:modelId',
  handler(async (req) => {
    requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const model = await modelOf(project.id, pathId(req, 'modelId'));
    try {
      const revised = await reviseModel(model.id, definitionFrom(bodyOf(req)));
      if (!revised) throw notFound(NOT_A_MODEL);
      return { model: revised };
    } catch (error) {
      return refusal(error);
    }
  }),
);

scenarioRouter.post(
  '/projects/:projectId/scenarios/:modelId/archive',
  handler(async (req) => {
    requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const model = await modelOf(project.id, pathId(req, 'modelId'));
    await archiveScenarioModel(model.id);
    return { archived: true };
  }),
);

scenarioRouter.post(
  '/projects/:projectId/scenarios/:modelId/runs',
  handler(async (req) => {
    const person = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const model = await modelOf(project.id, pathId(req, 'modelId'));
    const body = bodyOf(req);
    const options = optionsFrom(body);
    try {
      const run = await runModel({ model, options, label: optionalString(body.label, 'label') ?? null, createdById: person.id });
      return { run: runView(run) };
    } catch (error) {
      return refusal(error);
    }
  }),
);

scenarioRouter.get(
  '/projects/:projectId/scenarios/:modelId/runs/:runId',
  handler(async (req) => {
    requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const model = await modelOf(project.id, pathId(req, 'modelId'));
    const run = await getScenarioRun(pathId(req, 'runId'));
    if (!run || run.modelId !== model.id) throw notFound(NOT_A_MODEL);
    return { run: runView(run) };
  }),
);

/**
 * Re-run a recorded configuration and compare digests. Computes; writes
 * nothing. It takes the default WRITE level all the same: it spends the
 * process's one run slot, and a reader who could loop it would hold that slot
 * for everybody else.
 */
scenarioRouter.post(
  '/projects/:projectId/scenarios/:modelId/runs/:runId/reproduce',
  handler(async (req) => {
    requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const model = await modelOf(project.id, pathId(req, 'modelId'));
    const run = await getScenarioRun(pathId(req, 'runId'));
    if (!run || run.modelId !== model.id) throw notFound(NOT_A_MODEL);
    if (run.state !== 'COMPLETE') throw unprocessable('Only a completed run has a result to reproduce.');
    try {
      return { reproduction: await reproduce(run) };
    } catch (error) {
      return refusal(error);
    }
  }),
);
