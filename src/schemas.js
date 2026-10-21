'use strict';

/**
 * Response shapes, in two roles.
 *
 * For a local Ollama model they are handed to the server as a grammar
 * (`format: <schema>`), so the model physically cannot answer with prose around
 * its JSON, cannot invent fields, and stops as soon as the object is complete.
 * That removes the "repair the JSON" second generation, which on a small local
 * model used to cost as much as the answer itself.
 *
 * For every provider they are also the contract the reply is validated
 * against, so a malformed answer is detected once, in one place.
 */

const PLAN = {
  type: 'object',
  properties: {
    queries: { type: 'array', items: { type: 'string' } },
    refs: { type: 'array', items: { type: 'string' } },
  },
  required: ['queries', 'refs'],
};

const RANK = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    sources: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          justification: { type: 'string' },
          relevance: { type: 'number' },
        },
        required: ['index', 'justification', 'relevance'],
      },
    },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    caveats: { type: 'string' },
  },
  required: ['answer', 'sources', 'confidence', 'caveats'],
};

const GLOSS = {
  type: 'object',
  properties: {
    gloss: { type: 'string' },
    root: { type: 'string' },
    binyan: { type: 'string' },
    note: { type: 'string' },
  },
  required: ['gloss', 'root', 'binyan', 'note'],
};

const TRANSLATIONS = {
  type: 'object',
  properties: {
    translations: { type: 'array', items: { type: 'string' } },
  },
  required: ['translations'],
};

const TRANSLATION = {
  type: 'object',
  properties: {
    translation: { type: 'string' },
    note: { type: 'string' },
  },
  required: ['translation', 'note'],
};

const SCHEMAS = {
  plan: PLAN,
  rank: RANK,
  gloss: GLOSS,
  translate: TRANSLATIONS,
  'translate.selection': TRANSLATION,
};

/** The schema for a task, or null when the task answers in plain text. */
function schemaFor(task) {
  return SCHEMAS[task] || null;
}

module.exports = { SCHEMAS, schemaFor, PLAN, RANK, GLOSS, TRANSLATIONS, TRANSLATION };
