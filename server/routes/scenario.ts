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
  notFound,
  optionalString,
  pathId,
  requirePerson,
  requireProject,
  unprocessable,
} from './helpers.ts';
import { SCENARIO_LIMITS, VARIABLE_PROVENANCES, type RunOptions, type ScenarioModelDefinition } from '../domain/scenario.ts';
import { archiveScenarioModel, getScenarioModel, getScenarioRun, listScenarioModels, listScenarioRuns, type ScenarioModelRecord } from '../repos/scenario.ts';
import { ScenarioModelError } from '../services/scenario/model.ts';
import { ScenarioRunError } from '../services/scenario/engine.ts';
import { demonstration, normalizeOptions, readRunState, reproduce, reviseModel, runModel, saveModel } from '../services/scenario/service.ts';
import { demonstrationModel } from '../services/scenario/demo.ts';

export const scenarioRouter = Router();

const NOT_A_MODEL = 'No scenario model with that id.';

function refusal(error: unknown): never {
  if (error instanceof ScenarioModelError) throw unprocessable(error.message, { problems: error.problems });
  if (error instanceof ScenarioRunError) throw unprocessable(error.message);
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
    return demonstration();
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
    const run = await runModel({ model, options, label: optionalString(body.label, 'label') ?? null, createdById: person.id });
    return { run: runView(run) };
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

/** Re-run a recorded configuration and compare digests. Computes; writes nothing. */
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
      return { reproduction: reproduce(run) };
    } catch (error) {
      return refusal(error);
    }
  }),
);
